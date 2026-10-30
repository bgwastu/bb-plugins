// bb-plugin-web-push — real Web Push for bb's browser clients.
//
// Why this exists: bb's bundled push-notifications plugin shows web
// notifications with `new Notification(...)`, which Chromium refuses on
// Android ("Illegal constructor. Use ServiceWorkerRegistration
// showNotification() instead") and which requires an open, focused tab
// everywhere else. This plugin registers a service worker and does the real
// thing — VAPID + aes128gcm Web Push — so a phone (or a closed laptop browser)
// gets the notification with bb closed.
//
// Surfaces:
//   - `GET  /api/v1/plugins/web-push/http/sw.js`      service worker
//   - `GET  .../http/config`                          browser bootstrap
//   - `POST .../http/subscribe`                       browser → server
//   - `POST .../http/unsubscribe`
//   - `POST .../http/delivery`                        service worker ack
//   - `POST .../http/resubscribe`                      pushsubscriptionchange
//   - rpc: web_push_status / web_push_test / web_push_remove / web_push_subscriptions
//   - cli: `bb web-push …`
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  createVapidKeys,
  encryptPayload,
  isGoneStatus,
  vapidAuthorization,
  type VapidKeys,
} from "./push-crypto";
import { renderServiceWorker } from "./service-worker";

const PLUGIN_ID = "web-push";
const NOTIFICATIONS_PLUGIN_ID = "push-notifications";

const BASE_PATH = `/api/v1/plugins/${PLUGIN_ID}/http`;
const SW_PATH = `${BASE_PATH}/sw.js`;
const SW_SCOPE = `${BASE_PATH}/`;

const KV_VAPID = "vapid-keys";
const KV_OUTCOME = "last-outcome";
const KV_SUBSCRIPTION_PREFIX = "subscription:";

/** Wait this long before sending so a burst of events becomes one push. */
const COALESCE_MS = 1_500;
const REQUEST_TIMEOUT_MS = 10_000;
const REALTIME_CHANNEL = "web-push-changed";

type Kind = "pending-interaction" | "thread-error" | "turn-finished";
type Level = "all" | "input-only" | "muted";

const LEVEL_QUIETNESS: Record<Level, number> = { muted: 0, "input-only": 1, all: 2 };
const KINDS_BY_LEVEL: Record<Level, ReadonlySet<Kind>> = {
  all: new Set<Kind>(["pending-interaction", "thread-error", "turn-finished"]),
  "input-only": new Set<Kind>(["pending-interaction", "thread-error"]),
  muted: new Set<Kind>(),
};
const KIND_PRIORITY: readonly Kind[] = ["pending-interaction", "thread-error", "turn-finished"];
const KIND_HEADLINE: Record<Kind, string> = {
  "pending-interaction": "Waiting for your input",
  "thread-error": "The thread hit an error",
  "turn-finished": "Finished and waiting for you",
};

const subscriptionRecordSchema = z
  .object({
    id: z.string().min(1),
    endpoint: z.string().min(1).max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
    label: z.string().min(1).max(120),
    userAgent: z.string().max(400).nullable(),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
    lastDeliveredAt: z.number().int().nonnegative().nullable(),
    lastError: z.string().max(300).nullable(),
  })
  .strict();
type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>;

const outcomeSchema = z.union([
  z.object({ status: z.literal("never") }).strict(),
  z
    .object({
      status: z.literal("sent"),
      at: z.number().int().nonnegative(),
      sent: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pruned: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ status: z.literal("failed"), at: z.number().int().nonnegative(), reason: z.string() })
    .strict(),
  z.object({ status: z.literal("empty"), at: z.number().int().nonnegative() }).strict(),
]);
type DeliveryOutcome = z.infer<typeof outcomeSchema>;

const levelSchema = z.enum(["all", "input-only", "muted"]);

export const rpcContract = defineRpcContract({
  web_push_status: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      publicKey: z.string().nullable(),
      subscriptionCount: z.number().int().nonnegative(),
      outcome: outcomeSchema,
    }),
  },
  web_push_subscriptions: {
    input: z.null(),
    output: z.object({
      subscriptions: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          endpointHost: z.string(),
          createdAt: z.number(),
          lastSeenAt: z.number(),
          lastDeliveredAt: z.number().nullable(),
          lastError: z.string().nullable(),
        }),
      ),
    }),
  },
  web_push_remove: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  web_push_test: {
    input: z.null(),
    output: z.object({
      sent: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pruned: z.number().int().nonnegative(),
    }),
  },
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function firstLine(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function threadTitle(thread: { id: string; title: string | null; titleFallback: string | null }): string {
  const title = thread.title?.trim();
  if (title !== undefined && title !== "") return truncate(title, 80);
  const fallback = thread.titleFallback?.trim();
  if (fallback !== undefined && fallback !== "") return truncate(fallback, 80);
  return `Thread ${thread.id.slice(0, 8)}`;
}

function describeInteraction(interaction: Record<string, unknown> | null): string {
  if (interaction === null) return "";
  const payload = interaction.payload;
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  if (record.kind === "user_question") {
    const questions = Array.isArray(record.questions) ? record.questions : [];
    const first = questions[0];
    const prompt =
      typeof first === "object" && first !== null ? (first as Record<string, unknown>).prompt : undefined;
    return firstLine(typeof prompt === "string" ? prompt : "") || "The agent has a question for you";
  }
  if (record.kind === "approval") {
    const subject = record.subject;
    if (typeof subject === "object" && subject !== null) {
      const detail = subject as Record<string, unknown>;
      if (detail.kind === "command" && typeof detail.command === "string") {
        return `Approve command: ${firstLine(detail.command)}`;
      }
      if (detail.kind === "file_change") return "Approve file changes";
      if (detail.kind === "permission_grant") {
        return typeof detail.toolName === "string"
          ? `Grant permissions to ${detail.toolName}`
          : "Grant additional permissions";
      }
    }
    return "Review the plan before the agent continues";
  }
  const title = record.title;
  return typeof title === "string" && title !== "" ? title : "Waiting for your input";
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Send web push notifications",
      description:
        "Deliver thread notifications to browsers that enabled them in their bb settings. Works with the tab closed.",
      default: true,
    },
    notifyFinished: {
      type: "boolean",
      label: "Notify when a turn finishes",
      description: "Also subject to the thread's notification level.",
      default: true,
    },
    notifyInput: {
      type: "boolean",
      label: "Notify when a thread needs you",
      description: "Questions, approvals, and plan reviews.",
      default: true,
    },
    notifyError: {
      type: "boolean",
      label: "Notify when a thread fails",
      default: true,
    },
    useThreadLevels: {
      type: "boolean",
      label: "Respect thread notification levels",
      description:
        "Read the per-thread levels from the bundled Notifications plugin, so muted threads stay quiet.",
      default: true,
    },
    vapidSubject: {
      type: "string",
      label: "VAPID contact subject",
      description:
        "Push services require a contact: a mailto: or https: URL. Use your own address — some services reject placeholder domains.",
      default: "mailto:web-push@localhost",
    },
    urgency: {
      type: "select",
      label: "Delivery urgency",
      description: "Push services may throttle low-urgency messages while the device sleeps.",
      options: ["high", "normal", "low"],
      default: "high",
    },
  });

  // ---------------------------------------------------------------- storage ---

  async function readVapidKeys(): Promise<VapidKeys> {
    const stored = await bb.storage.kv.get<VapidKeys>(KV_VAPID);
    if (stored !== undefined && stored !== null) {
      const parsed = z
        .object({ publicKey: z.string().min(1), privateKey: z.string().min(1) })
        .strict()
        .safeParse(stored);
      if (parsed.success) return parsed.data;
      bb.log.warn("stored VAPID keys were unreadable; regenerating");
    }
    const created = createVapidKeys();
    await bb.storage.kv.set(KV_VAPID, created);
    bb.log.info(`generated a VAPID key pair (${created.publicKey.slice(0, 12)}…)`);
    return created;
  }

  const vapidKeys = await readVapidKeys();

  let subscriptionQueue: Promise<unknown> = Promise.resolve();
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = subscriptionQueue.then(operation, operation);
    subscriptionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function readSubscriptions(): Promise<SubscriptionRecord[]> {
    const keys = await bb.storage.kv.list(KV_SUBSCRIPTION_PREFIX);
    const rows: SubscriptionRecord[] = [];
    for (const key of keys) {
      const parsed = subscriptionRecordSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success) {
        bb.log.warn(`ignored unreadable push subscription ${key.slice(KV_SUBSCRIPTION_PREFIX.length)}`);
        continue;
      }
      rows.push(parsed.data);
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async function upsertSubscription(input: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    label: string;
    userAgent: string | null;
  }): Promise<{ record: SubscriptionRecord; created: boolean }> {
    return mutate(async () => {
      const now = Date.now();
      const existing = (await readSubscriptions()).find((row) => row.endpoint === input.endpoint);
      if (existing !== undefined) {
        const updated: SubscriptionRecord = {
          ...existing,
          keys: input.keys,
          label: input.label,
          userAgent: input.userAgent,
          lastSeenAt: now,
          // A refresh proves the endpoint works again; old errors stop applying.
          lastError: null,
        };
        await bb.storage.kv.set(`${KV_SUBSCRIPTION_PREFIX}${existing.id}`, updated);
        return { record: updated, created: false };
      }
      const record: SubscriptionRecord = {
        id: randomUUID(),
        endpoint: input.endpoint,
        keys: input.keys,
        label: input.label,
        userAgent: input.userAgent,
        createdAt: now,
        lastSeenAt: now,
        lastDeliveredAt: null,
        lastError: null,
      };
      await bb.storage.kv.set(`${KV_SUBSCRIPTION_PREFIX}${record.id}`, record);
      bb.log.info(`registered push device "${record.label}" (${record.id})`);
      return { record, created: true };
    });
  }

  async function removeSubscriptionById(id: string): Promise<boolean> {
    return mutate(async () => {
      const existing = (await readSubscriptions()).find((row) => row.id === id);
      if (existing === undefined) return false;
      await bb.storage.kv.delete(`${KV_SUBSCRIPTION_PREFIX}${id}`);
      return true;
    });
  }

  async function removeSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
    return mutate(async () => {
      const existing = (await readSubscriptions()).find((row) => row.endpoint === endpoint);
      if (existing === undefined) return false;
      await bb.storage.kv.delete(`${KV_SUBSCRIPTION_PREFIX}${existing.id}`);
      return true;
    });
  }

  async function noteDelivery(endpoint: string | null, shownAt: number): Promise<void> {
    if (endpoint === null) return;
    await mutate(async () => {
      const existing = (await readSubscriptions()).find((row) => row.endpoint === endpoint);
      if (existing === undefined) return;
      await bb.storage.kv.set(`${KV_SUBSCRIPTION_PREFIX}${existing.id}`, {
        ...existing,
        lastSeenAt: Math.max(existing.lastSeenAt, shownAt),
        lastDeliveredAt: Math.max(existing.lastDeliveredAt ?? 0, shownAt),
        lastError: null,
      } satisfies SubscriptionRecord);
    });
    bb.realtime.publish(REALTIME_CHANNEL, { at: shownAt });
  }

  async function noteFailure(id: string, message: string): Promise<void> {
    await mutate(async () => {
      const existing = (await readSubscriptions()).find((row) => row.id === id);
      if (existing === undefined) return;
      await bb.storage.kv.set(`${KV_SUBSCRIPTION_PREFIX}${id}`, {
        ...existing,
        lastError: message.slice(0, 300),
      } satisfies SubscriptionRecord);
    });
  }

  let lastOutcome: DeliveryOutcome = { status: "never" };
  async function setOutcome(outcome: DeliveryOutcome): Promise<void> {
    lastOutcome = outcome;
    await bb.storage.kv.set(KV_OUTCOME, outcome);
  }
  const storedOutcome = outcomeSchema.safeParse(await bb.storage.kv.get(KV_OUTCOME));
  if (storedOutcome.success) lastOutcome = storedOutcome.data;

  // -------------------------------------------------------------- delivery ---

  async function sendToSubscription(
    subscription: SubscriptionRecord,
    body: string,
    subject: string,
    urgency: string,
  ): Promise<{ ok: boolean; gone: boolean; error?: string }> {
    let encrypted: { body: Buffer };
    try {
      encrypted = encryptPayload({ payload: body, keys: subscription.keys });
    } catch (error) {
      return { ok: false, gone: false, error: `encrypt failed: ${messageOf(error)}` };
    }
    let authorization: string;
    try {
      authorization = vapidAuthorization({
        endpoint: subscription.endpoint,
        keys: vapidKeys,
        subject,
      });
    } catch (error) {
      return { ok: false, gone: false, error: `vapid failed: ${messageOf(error)}` };
    }
    try {
      const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: urgency,
        },
        body: new Uint8Array(encrypted.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, gone: false };
      if (isGoneStatus(response.status)) return { ok: false, gone: true, error: `HTTP ${response.status}` };
      const detail = truncate(await response.text().catch(() => ""), 200);
      return { ok: false, gone: false, error: `HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}` };
    } catch (error) {
      return { ok: false, gone: false, error: messageOf(error) };
    }
  }

  async function deliver(payload: {
    title: string;
    body: string;
    threadId: string | null;
    kind: Kind | "message";
    tag?: string;
  }): Promise<{ sent: number; failed: number; pruned: number }> {
    const config = await settings.get();
    const subscriptions = await readSubscriptions();
    if (subscriptions.length === 0) {
      bb.log.info("no push devices registered; nothing sent");
      return { sent: 0, failed: 0, pruned: 0 };
    }
    const message = JSON.stringify({
      title: truncate(payload.title, 80),
      body: truncate(payload.body, 180),
      threadId: payload.threadId,
      kind: payload.kind,
      url: payload.threadId === null ? "/" : `/threads/${payload.threadId}`,
      tag: payload.tag ?? `bb-${payload.kind}${payload.threadId === null ? "" : `-${payload.threadId}`}`,
    });

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    for (const subscription of subscriptions) {
      const result = await sendToSubscription(subscription, message, config.vapidSubject, config.urgency);
      if (result.ok) {
        sent += 1;
        continue;
      }
      if (result.gone) {
        pruned += 1;
        await removeSubscriptionById(subscription.id);
        bb.log.info(`dropped push device ${subscription.id}: the push service says it is gone`);
        continue;
      }
      failed += 1;
      await noteFailure(subscription.id, result.error ?? "unknown error");
      bb.log.warn(`push to ${subscription.label} (${subscription.id}) failed: ${result.error ?? "unknown"}`);
    }
    if (sent > 0) {
      bb.log.info(`sent "${payload.title}" to ${sent} browser(s)${failed + pruned === 0 ? "" : `, ${failed} failed, ${pruned} dropped`}`);
      await setOutcome({ status: "sent", at: Date.now(), sent, failed, pruned });
    } else if (failed === 0 && pruned > 0) {
      await setOutcome({ status: "empty", at: Date.now() });
    } else if (failed > 0) {
      await setOutcome({ status: "failed", at: Date.now(), reason: "every push request failed" });
    }
    bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now(), sent, failed, pruned });
    return { sent, failed, pruned };
  }
  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ---------------------------------------------------------------- levels ---

  const builtinLevelsSchema = z.object({
    threads: z.record(
      z.string(),
      z.object({
        own: z.enum(["inherit", "all", "input-only", "muted"]),
        ancestorCap: z
          .object({ level: levelSchema, threadId: z.string() })
          .strict()
          .nullable(),
      }),
    ),
  });

  type BuiltinLevels = {
    defaultLevel: Level;
    childLevel: "inherit" | Level;
  };

  async function readBuiltinDefaults(): Promise<BuiltinLevels> {
    try {
      const response = await bb.sdk.plugins.getSettings({ pluginId: NOTIFICATIONS_PLUGIN_ID });
      const values = response.values as Record<string, unknown>;
      const defaultLevel = levelSchema.safeParse(values.defaultLevel);
      const childLevel = z
        .enum(["inherit", "all", "input-only", "muted"])
        .safeParse(values.childLevel);
      return {
        defaultLevel: defaultLevel.success ? defaultLevel.data : "all",
        childLevel: childLevel.success ? childLevel.data : "input-only",
      };
    } catch {
      return { defaultLevel: "all", childLevel: "input-only" };
    }
  }

  async function readBuiltinThreadLevels(
    threadId: string,
  ): Promise<{ own: "inherit" | Level; ancestorCap: { level: Level } | null } | null> {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: NOTIFICATIONS_PLUGIN_ID,
        method: "threadNotifications.list",
        input: { threadIds: [threadId] },
        outputSchema: builtinLevelsSchema,
      });
      const row = result.threads[threadId];
      if (row === undefined) return null;
      return { own: row.own, ancestorCap: row.ancestorCap };
    } catch {
      return null;
    }
  }

  async function effectiveLevel(thread: {
    id: string;
    parentThreadId: string | null;
  }): Promise<Level> {
    const config = await settings.get();
    if (!config.useThreadLevels) return "all";
    const [defaults, builtin] = await Promise.all([
      readBuiltinDefaults(),
      readBuiltinThreadLevels(thread.id),
    ]);
    const own = builtin?.own ?? "inherit";
    const childDefault: Level =
      defaults.childLevel === "inherit" ? defaults.defaultLevel : defaults.childLevel;
    let level: Level =
      own !== "inherit" ? own : thread.parentThreadId !== null ? childDefault : defaults.defaultLevel;
    const cap = builtin?.ancestorCap ?? null;
    if (cap !== null && LEVEL_QUIETNESS[cap.level] < LEVEL_QUIETNESS[level]) level = cap.level;
    return level;
  }

  // ----------------------------------------------------------- notifications ---

  type Pending = {
    kinds: Set<Kind>;
    bodies: Map<Kind, string>;
    threadId: string;
    eventAt: number;
    timer: NodeJS.Timeout;
  };
  const pending = new Map<string, Pending>();

  function schedule(threadId: string, kind: Kind, body: string): void {
    const existing = pending.get(threadId);
    const now = Date.now();
    if (existing !== undefined) {
      existing.kinds.add(kind);
      existing.bodies.set(kind, body);
      existing.eventAt = Math.max(existing.eventAt, now);
      return;
    }
    const entry: Pending = {
      kinds: new Set([kind]),
      bodies: new Map([[kind, body]]),
      threadId,
      eventAt: now,
      timer: setTimeout(() => {
        pending.delete(threadId);
        void flush(entry).catch((error: unknown) => {
          bb.log.error(`web push flush failed for ${threadId}: ${messageOf(error)}`);
        });
      }, COALESCE_MS),
    };
    entry.timer.unref?.();
    pending.set(entry.threadId, entry);
  }

  async function flush(entry: Pending): Promise<void> {
    const config = await settings.get();
    if (!config.enabled) return;
    const thread = await loadThread(entry.threadId);
    if (thread === null) return;
    const lastReadAt = thread.lastReadAt ?? 0;
    if (lastReadAt >= entry.eventAt) return;

    const level = await effectiveLevel(thread);
    const allowed = KINDS_BY_LEVEL[level];
    const kinds = [...entry.kinds].filter((kind) => allowed.has(kind));
    if (kinds.length === 0) return;

    let kind: Kind | null = null;
    for (const candidate of KIND_PRIORITY) {
      if (!kinds.includes(candidate)) continue;
      if (candidate === "turn-finished") {
        if (thread.status !== "idle") continue;
        if (!config.notifyFinished) continue;
      }
      if (candidate === "thread-error") {
        if (thread.status !== "error") continue;
        if (!config.notifyError) continue;
      }
      if (candidate === "pending-interaction" && !config.notifyInput) continue;
      kind = candidate;
      break;
    }
    if (kind === null) return;

    let body = entry.bodies.get(kind) ?? "";
    if (kind === "pending-interaction") {
      const interaction = await loadPendingInteraction(thread.id);
      if (interaction === null) return;
      body = describeInteraction(interaction);
    }
    await deliver({
      title: threadTitle(thread),
      body: body === "" ? KIND_HEADLINE[kind] : body,
      threadId: thread.id,
      kind,
    });
  }

  async function loadThread(threadId: string): Promise<{
    id: string;
    title: string | null;
    titleFallback: string | null;
    status: string;
    parentThreadId: string | null;
    lastReadAt: number | null;
    archivedAt: number | null;
    deletedAt: number | null;
    visibility: string;
  } | null> {
    try {
      const thread = (await bb.sdk.threads.get({ threadId })) as unknown as {
        id: string;
        title: string | null;
        titleFallback: string | null;
        status: string;
        parentThreadId: string | null;
        lastReadAt: number | null;
        archivedAt: number | null;
        deletedAt: number | null;
        visibility: string;
      };
      if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
      if (thread.visibility !== "visible") return null;
      return thread;
    } catch {
      return null;
    }
  }

  async function loadPendingInteraction(threadId: string): Promise<Record<string, unknown> | null> {
    try {
      const result = (await bb.sdk.threads.interactions.list({ threadId })) as unknown as Array<
        Record<string, unknown>
      >;
      const open = result.find((row) => row.status === "pending");
      return open ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ rpc ---

  bb.rpc.register(rpcContract, {
    web_push_status: async () => {
      const config = await settings.get();
      const subscriptions = await readSubscriptions();
      return {
        enabled: config.enabled,
        publicKey: vapidKeys.publicKey,
        subscriptionCount: subscriptions.length,
        outcome: lastOutcome,
      };
    },
    web_push_subscriptions: async () => ({
      subscriptions: (await readSubscriptions()).map((row) => ({
        id: row.id,
        label: row.label,
        endpointHost: hostOf(row.endpoint),
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        lastDeliveredAt: row.lastDeliveredAt,
        lastError: row.lastError,
      })),
    }),
    web_push_remove: async ({ id }) => {
      const removed = await removeSubscriptionById(id);
      if (removed) bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
      return { removed };
    },
    web_push_test: async () => {
      const result = await deliver({
        title: "bb web push is working",
        body: "You will get thread notifications here, even with bb closed.",
        threadId: null,
        kind: "message",
        tag: "bb-web-push-test",
      });
      return result;
    },
  });

  function hostOf(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return "unknown";
    }
  }

  // ------------------------------------------------------------- http api ---

  bb.http.route(
    "GET",
    "/sw.js",
    () =>
      new Response(
        renderServiceWorker({
          publicKey: vapidKeys.publicKey,
          deliveryPath: `${BASE_PATH}/delivery`,
          resubscribePath: `${BASE_PATH}/resubscribe`,
        }),
        {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
            "service-worker-allowed": SW_SCOPE,
          },
        },
      ),
    { auth: "local" },
  );

  bb.http.route(
    "GET",
    "/config",
    async () => {
      const config = await settings.get();
      return jsonResponse({
        enabled: config.enabled,
        publicKey: vapidKeys.publicKey,
        swPath: SW_PATH,
        scope: SW_SCOPE,
      });
    },
    { auth: "local" },
  );

  const subscribeInputSchema = z.object({
    endpoint: z.string().min(1).max(2048),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
    label: z.string().min(1).max(120).optional(),
    userAgent: z.string().max(400).nullable().optional(),
  });

  bb.http.route(
    "POST",
    "/subscribe",
    async (context) => {
      const parsed = subscribeInputSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return jsonResponse({ ok: false, error: "invalid subscription" }, 400);
      const { record, created } = await upsertSubscription({
        endpoint: parsed.data.endpoint,
        keys: parsed.data.keys,
        label: parsed.data.label ?? "Browser",
        userAgent: parsed.data.userAgent ?? null,
      });
      bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
      return jsonResponse({ ok: true, id: record.id, created });
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    "/unsubscribe",
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as { endpoint?: unknown } | null;
      const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
      if (endpoint === null) return jsonResponse({ ok: false, error: "endpoint required" }, 400);
      const removed = await removeSubscriptionByEndpoint(endpoint);
      if (removed) bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
      return jsonResponse({ ok: true, removed });
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    "/delivery",
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as
        | { endpoint?: unknown; shownAt?: unknown }
        | null;
      const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
      const shownAt = typeof body?.shownAt === "number" ? body.shownAt : Date.now();
      await noteDelivery(endpoint, shownAt);
      return jsonResponse({ ok: true });
    },
    { auth: "local" },
  );

  bb.http.route(
    "POST",
    "/resubscribe",
    async (context) => {
      const parsed = subscribeInputSchema
        .extend({ previousEndpoint: z.string().max(2048).nullable().optional() })
        .safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return jsonResponse({ ok: false, error: "invalid subscription" }, 400);
      if (typeof parsed.data.previousEndpoint === "string") {
        await removeSubscriptionByEndpoint(parsed.data.previousEndpoint);
      }
      const { record } = await upsertSubscription({
        endpoint: parsed.data.endpoint,
        keys: parsed.data.keys,
        label: parsed.data.label ?? "Renewed subscription",
        userAgent: parsed.data.userAgent ?? null,
      });
      bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
      return jsonResponse({ ok: true, id: record.id });
    },
    { auth: "local" },
  );

  // -------------------------------------------------------------- events ---

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    schedule(thread.id, "turn-finished", firstLine(lastAssistantText));
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    schedule(thread.id, "thread-error", firstLine(error));
  });

  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    schedule(thread.id, "pending-interaction", describeInteraction(interaction as Record<string, unknown>));
  });

  // ----------------------------------------------------------------- cli ---

  bb.cli.register({
    name: "web-push",
    summary: "Manage bb's real Web Push delivery to browsers",
    commands: [
      { name: "status", summary: "Show delivery status", usage: "bb web-push status [--json]" },
      { name: "list", summary: "List subscribed browsers", usage: "bb web-push list [--json]" },
      { name: "key", summary: "Print the VAPID public key", usage: "bb web-push key [--json]" },
      {
        name: "remove",
        summary: "Remove a subscribed browser",
        usage: "bb web-push remove <id> [--json]",
      },
      { name: "test", summary: "Send a test notification", usage: "bb web-push test [--json]" },
      {
        name: "send",
        summary: "Send a notification",
        usage: "bb web-push send --title <text> [--body <text>] [--thread <id>] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return {
            exitCode: 0,
            stdout: [
              "Usage:",
              "  bb web-push status [--json]",
              "  bb web-push list [--json]",
              "  bb web-push key [--json]",
              "  bb web-push remove <id> [--json]",
              "  bb web-push test [--json]",
              "  bb web-push send --title <text> [--body <text>] [--thread <id>] [--json]",
            ].join("\n"),
          };
        case "status": {
          const config = await settings.get();
          const subscriptions = await readSubscriptions();
          const value = {
            enabled: config.enabled,
            subscriptions: subscriptions.length,
            vapidPublicKey: vapidKeys.publicKey,
            outcome: lastOutcome,
          };
          return reply(
            value,
            [
              `Enabled: ${config.enabled}`,
              `Subscribed browsers: ${subscriptions.length}`,
              `Last send: ${
                lastOutcome.status === "never"
                  ? "never"
                  : lastOutcome.status === "sent"
                    ? `sent to ${lastOutcome.sent} at ${new Date(lastOutcome.at).toISOString()}`
                    : lastOutcome.status === "failed"
                      ? `failed at ${new Date(lastOutcome.at).toISOString()} (${lastOutcome.reason})`
                      : `nothing to send at ${new Date(lastOutcome.at).toISOString()}`
              }`,
              `VAPID public key: ${vapidKeys.publicKey}`,
            ].join("\n"),
          );
        }
        case "key":
          return reply({ publicKey: vapidKeys.publicKey }, vapidKeys.publicKey);
        case "list": {
          const rows = await readSubscriptions();
          const value = rows.map((row) => ({
            id: row.id,
            label: row.label,
            host: hostOf(row.endpoint),
            created: new Date(row.createdAt).toISOString(),
            lastDelivered:
              row.lastDeliveredAt === null ? null : new Date(row.lastDeliveredAt).toISOString(),
            lastError: row.lastError,
          }));
          if (rows.length === 0) return reply(value, "No browsers subscribed.");
          return reply(
            value,
            [
              "ID\tLabel\tHost\tLast delivered\tLast error",
              ...rows.map((row) =>
                [
                  row.id,
                  row.label,
                  hostOf(row.endpoint),
                  row.lastDeliveredAt === null ? "never" : new Date(row.lastDeliveredAt).toISOString(),
                  row.lastError ?? "-",
                ].join("\t"),
              ),
            ].join("\n"),
          );
        }
        case "remove": {
          const id = rest[0];
          if (id === undefined) return { exitCode: 1, stderr: "Usage: bb web-push remove <id>" };
          const removed = await removeSubscriptionById(id);
          if (!removed) {
            return { exitCode: 1, stderr: `No subscribed browser with id ${id}` };
          }
          bb.realtime.publish(REALTIME_CHANNEL, { at: Date.now() });
          return reply({ id, removed: true }, `Removed ${id}`);
        }
        case "test": {
          const result = await deliver({
            title: "bb web push is working",
            body: "Thread notifications will arrive here, even with bb closed.",
            threadId: null,
            kind: "message",
            tag: "bb-web-push-test",
          });
          if (result.sent === 0) {
            return {
              exitCode: 1,
              stderr: `Nothing was delivered (sent ${result.sent}, failed ${result.failed}, pruned ${result.pruned}).`,
            };
          }
          return reply(result, `Sent to ${result.sent} browser(s).`);
        }
        case "send": {
          const titleIndex = rest.indexOf("--title");
          const bodyIndex = rest.indexOf("--body");
          const threadIndex = rest.indexOf("--thread");
          const title = titleIndex === -1 ? undefined : rest[titleIndex + 1];
          if (title === undefined || title.startsWith("--")) {
            return {
              exitCode: 1,
              stderr: "Usage: bb web-push send --title <text> [--body <text>] [--thread <id>]",
            };
          }
          const body = bodyIndex === -1 ? "" : (rest[bodyIndex + 1] ?? "");
          const threadId = threadIndex === -1 ? null : (rest[threadIndex + 1] ?? null);
          const result = await deliver({ title, body, threadId, kind: "message" });
          return reply(result, `Sent to ${result.sent} browser(s), ${result.failed} failed.`);
        }
        default:
          return { exitCode: 1, stderr: `Unknown command "${command}". Run "bb web-push help".` };
      }
    },
  });

  // --------------------------------------------------------------- dispose ---

  bb.onDispose(() => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    bb.log.info("disposed");
  });
}
