import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, "assets", "audio");

const SSE_KEEPALIVE_MS = 20_000;
const DEDUPE_WINDOW_MS = 2_000;

import { SOUND_NAMES } from "./sound-names";
export const SOUND_CHOICES = SOUND_NAMES;

export interface ChimeEvent {
  ring: true;
  type: "idle" | "failed" | "test";
  sound: string;
  volume: string;
  trigger: "always" | "hidden-only";
  threadId?: string;
  timestamp: number;
}

export const rpcContract = defineRpcContract({
  bell_test: {
    input: z.object({ sound: z.string().optional() }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  bell_status: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      activeListeners: z.number(),
      sound: z.string(),
      trigger: z.string(),
      volume: z.string(),
    }),
  },
  bell_update_settings: {
    input: z
      .object({
        sound: z.string().optional(),
        workflowSound: z.string().optional(),
        failSound: z.string().optional(),
      })
      .refine((value) => Object.keys(value).length > 0, "At least one sound setting is required"),
    output: z.object({
      ok: z.boolean(),
      settings: z.record(z.string(), z.union([z.string(), z.boolean()])),
    }),
  },
});

interface SseSubscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

function sseData(controller: ReadableStreamDefaultController<Uint8Array>, data: unknown): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    sound: {
      type: "select",
      label: "Turn finish sound",
      description: "Audio effect played when a main thread turn finishes.",
      options: [...SOUND_CHOICES],
      default: "bip-bop-01",
    },
    onIdle: {
      type: "boolean",
      label: "Chime on turn finish",
      description: "Play chime when an agent turn completes successfully.",
      default: true,
    },
    workflowSound: {
      type: "select",
      label: "Workflow finish sound",
      description: "Audio effect played when a workflow, sub-workflow, or subagent finishes.",
      options: [...SOUND_CHOICES],
      default: "yup-01",
    },
    onFailed: {
      type: "boolean",
      label: "Chime on turn failed",
      description: "Play chime when an agent turn fails.",
      default: true,
    },
    failSound: {
      type: "select",
      label: "Failed sound effect",
      description: "Audio effect played when an agent turn fails.",
      options: [...SOUND_CHOICES],
      default: "nope-03",
    },
    chimeOnWorkflow: {
      type: "boolean",
      label: "Chime on workflow / subagent",
      description: "Play chime when a workflow or subagent completes.",
      default: true,
    },
    trigger: {
      type: "select",
      label: "When to chime",
      description: "Chime always, or only when the browser tab/window is in the background.",
      options: ["always", "hidden-only"],
      default: "always",
    },
    volume: {
      type: "string",
      label: "Volume (0.0 to 1.0)",
      description: "Volume level between 0.0 and 1.0 (default 0.8)",
      default: "0.8",
    },
  });

  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
    bb.log.info("Chiming bell settings updated");
  });

  // Server-push (SSE) delivery. One open stream per bb window replaces the
  // old long-poll loop: the handler returns immediately, so handler time stays
  // near zero and each client holds a single connection instead of re-polling.
  const subscribers = new Set<SseSubscriber>();
  const lastChimedAt = new Map<string, number>();
  let latestClientStatus: {
    isUnlocked: boolean;
    state: string;
    lastError: string | null;
    lastPlayedTime: number;
  } | null = null;

  let keepaliveTimer: NodeJS.Timeout | null = null;

  function stopKeepaliveIfIdle() {
    if (subscribers.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function triggerChime(
    type: "idle" | "failed" | "test",
    soundName: string,
    threadId?: string,
  ): void {
    const event: ChimeEvent = {
      ring: true,
      type,
      sound: soundName,
      volume: current.volume,
      trigger: current.trigger as "always" | "hidden-only",
      threadId,
      timestamp: Date.now(),
    };

    bb.log.info(`Chiming bell: ${type} -> sound: ${soundName} (thread: ${threadId ?? "none"})`);
    bb.realtime.publish("bell:ring", event);

    for (const sub of subscribers) {
      try {
        sseData(sub.controller, event);
      } catch {
        // Stream is gone; cleanup happens on abort/cancel.
      }
    }
  }

  // SSE push stream: each connected bb window opens one long-lived GET and
  // receives chime events the moment they fire. The handler resolves as soon as
  // the stream is created, so it is not counted as a hung handler.
  // SSE push stream: each connected bb window opens one long-lived GET and
  // receives chime events the moment they fire. The handler resolves as soon as
  // the stream is created, so it is not counted as a hung handler.
  bb.http.route("GET", "/events", (context) => {
    const { signal } = context.req.raw;
    let sub: SseSubscriber | null = null;

    function detach() {
      if (sub) {
        subscribers.delete(sub);
        sub = null;
        stopKeepaliveIfIdle();
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        sub = { controller };
        subscribers.add(sub);
        sseData(controller, { ok: true, listeners: subscribers.size });

        if (!keepaliveTimer) {
          keepaliveTimer = setInterval(() => {
            if (subscribers.size === 0) {
              stopKeepaliveIfIdle();
              return;
            }
            for (const s of subscribers) {
              try {
                s.controller.enqueue(encoder.encode(`: keepalive\n\n`));
              } catch {
                // Stream is gone; cleanup happens on abort/cancel.
              }
            }
          }, SSE_KEEPALIVE_MS);
        }
      },
      cancel() {
        detach();
      },
    });

    signal.addEventListener("abort", detach, { once: true });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  // HTTP route: serve audio files (fallback when Web Audio is unavailable)
  bb.http.route("GET", "/audio", async (context) => {
    const sound = context.req.query("sound") || "alert-01";
    const safeName = sound.replace(/[^a-z0-9_-]/gi, "");
    const audioPath = path.join(ASSETS_DIR, `${safeName}.mp3`);

    try {
      const buffer = await fs.promises.readFile(audioPath);
      return new Response(buffer, {
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return context.text("Audio file not found", 404);
    }
  });

  // HTTP route: client status heartbeat (throttled client-side)
  bb.http.route("POST", "/status-ping", async (context) => {
    const body: unknown = await context.req.json().catch(() => ({}));
    if (typeof body === "object" && body !== null) {
      latestClientStatus = body as any;
    }
    return context.json({ ok: true });
  });

  // HTTP route: trigger test chime
  bb.http.route("POST", "/test", async (context) => {
    const body: unknown = await context.req.json().catch(() => ({}));
    const reqSound =
      typeof body === "object" && body !== null && "sound" in body
        ? String((body as { sound?: unknown }).sound)
        : current.sound;
    triggerChime("test", reqSound);
    return context.json({ ok: true, sound: reqSound });
  });

  async function isThreadInterruptedOrCancelled(threadId: string): Promise<boolean> {
    try {
      const listPromise = bb.sdk.threads.events.list({
        threadId,
        limit: "10",
        order: "desc",
        types: [
          "turn/completed",
          "system/thread/interrupted",
          "turn/started",
          "system/thread-provisioning",
          "system/interaction/lifecycle",
          "system/userQuestion/lifecycle",
        ],
      });

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 2000),
      );

      const events = await Promise.race([listPromise, timeoutPromise]);
      if (!events || events.length === 0) {
        return false;
      }

      for (const ev of events) {
        if (ev.type === "turn/completed") {
          const status = (ev.data as any)?.status;
          if (status === "interrupted") {
            return true;
          }
          if (status === "completed") {
            return false;
          }
        }

        if (ev.type === "system/thread/interrupted") {
          return true;
        }

        if (ev.type === "system/thread-provisioning") {
          const status = (ev.data as any)?.status;
          if (status === "cancelled") {
            return true;
          }
        }

        if (
          ev.type === "system/interaction/lifecycle" ||
          ev.type === "system/userQuestion/lifecycle"
        ) {
          const status = (ev.data as any)?.status;
          if (status === "interrupted") {
            return true;
          }
        }
      }

      return false;
    } catch (err) {
      bb.log.warn(`[bell] Failed to inspect thread events for ${threadId}: ${err}`);
      return false;
    }
  }

  // Thread lifecycle events
  bb.events.on("thread.idle", async ({ thread }) => {
    const originKind = thread.originKind as string | null;
    const isWorkflow =
      thread.originPluginId === "workflows" ||
      thread.originPluginId === "simple-subagent" ||
      originKind === "workflow" ||
      originKind === "subagent" ||
      Boolean(thread.parentThreadId);

    if (isWorkflow) {
      if (!current.chimeOnWorkflow) return;
    } else {
      if (!current.onIdle) return;
    }

    if (await isThreadInterruptedOrCancelled(thread.id)) {
      bb.log.info(`[bell] Suppressing chime for stopped/interrupted thread: ${thread.id}`);
      return;
    }

    const now = Date.now();
    const last = lastChimedAt.get(thread.id);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return;
    }
    lastChimedAt.set(thread.id, now);

    const soundToPlay = isWorkflow ? current.workflowSound : current.sound;
    triggerChime(isWorkflow ? ("workflow" as any) : "idle", soundToPlay, thread.id);
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (!current.onFailed) return;

    if (
      typeof error === "string" &&
      /cancelled|interrupted|manual-stop|stopped by user|abort/i.test(error)
    ) {
      bb.log.info(`[bell] Suppressing fail chime for cancelled thread: ${thread.id}`);
      return;
    }

    if (await isThreadInterruptedOrCancelled(thread.id)) {
      bb.log.info(`[bell] Suppressing fail chime for stopped/interrupted thread: ${thread.id}`);
      return;
    }

    const now = Date.now();
    const last = lastChimedAt.get(thread.id);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
      return;
    }
    lastChimedAt.set(thread.id, now);
    triggerChime("failed", current.failSound, thread.id);
  });

  // RPC registration
  bb.rpc.register(rpcContract, {
    bell_test({ sound }) {
      const soundToPlay = sound || current.sound;
      triggerChime("test", soundToPlay);
      return { ok: true, message: `Played ${soundToPlay}` };
    },
    bell_status() {
      return {
        ok: true,
        activeListeners: subscribers.size,
        sound: current.sound,
        trigger: current.trigger,
        volume: current.volume,
      };
    },
    async bell_update_settings(values) {
      const updates = Object.fromEntries(
        Object.entries(values).filter(([, value]) => typeof value === "string" && value.length > 0),
      );
      await bb.sdk.plugins.updateSettings({ pluginId: "bell", values: updates });
      current = { ...current, ...updates };
      return { ok: true, settings: current as Record<string, string | boolean> };
    },
  });

  // CLI registration
  bb.cli.register({
    name: "bell",
    summary: "Manage and test session finish chime bells",
    commands: [
      {
        name: "test",
        summary: "Play a test chime bell in the active BB app window",
        usage: "bb bell test [sound-name]",
      },
      {
        name: "status",
        summary: "Show current chime settings and listener status",
        usage: "bb bell status",
      },
      {
        name: "check",
        summary: "Check if a thread was interrupted or cancelled",
        usage: "bb bell check <thread-id>",
      },
    ],
    async run(argv) {
      const [cmd, soundArg] = argv;
      if (cmd === "check") {
        const threadId = soundArg;
        if (!threadId) {
          return { exitCode: 1, stderr: "Usage: bb bell check <thread-id>\n" };
        }
        const interrupted = await isThreadInterruptedOrCancelled(threadId);
        return {
          exitCode: 0,
          stdout: `Thread ${threadId}: ${interrupted ? "INTERRUPTED/CANCELLED (sound suppressed)" : "NORMAL COMPLETION (sound allowed)"}\n`,
        };
      }
      if (cmd === "test") {
        const soundToPlay = soundArg || current.sound;
        triggerChime("test", soundToPlay);
        return {
          exitCode: 0,
          stdout: `Triggered test chime: "${soundToPlay}" (${subscribers.size} connected window(s))\n`,
        };
      }

      if (cmd === "status" || !cmd) {
        const clientLine = latestClientStatus
          ? `Browser Audio: ${latestClientStatus.state} (${latestClientStatus.isUnlocked ? "unlocked & ready" : "suspended - click anywhere in BB once to unlock"})\nLast Error:    ${latestClientStatus.lastError || "none"}`
          : "Browser Audio: waiting for client tab heartbeat";
        const lines = [
          `Sound (main):     ${current.sound}`,
          `Sound (workflow): ${current.workflowSound}`,
          `Fail sound:       ${current.failSound}`,
          `Trigger:          ${current.trigger}`,
          `Volume:           ${current.volume}`,
          `Chime on main:    ${current.onIdle}`,
          `Chime on sub/wf:  ${current.chimeOnWorkflow}`,
          `Chime on fail:    ${current.onFailed}`,
          `Connected tabs:   ${subscribers.size}`,
          clientLine,
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      return { exitCode: 1, stderr: "Unknown command. Use: bb bell <test|status>\n" };
    },
  });

  bb.onDispose(() => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    subscribers.clear();
    lastChimedAt.clear();
  });
}
