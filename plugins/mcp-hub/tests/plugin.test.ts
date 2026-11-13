// The whole backend through the real host contract: load, migrate, register,
// add a server, connect, resolve a thread's selection, call a tool.
//
// The fake `bb` deliberately mirrors the SDK's shapes rather than our own
// modules, so a wiring mistake fails here instead of in a running BB.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { emptyDatabase, fixture } from "./helpers.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: unknown, ctx: { threadId: string; projectId: string }) => Promise<unknown>;
}

function harness() {
  const db = emptyDatabase();
  const kv = new Map<string, unknown>();
  const metadata: Record<string, Record<string, unknown>> = {};
  const tools = new Map<string, RegisteredTool>();
  const handlers: Record<string, (input: unknown) => Promise<unknown> | unknown> = {};
  const services: { name: string; start(signal: AbortSignal): Promise<void> | void }[] = [];
  const schedules: { name: string; cron: string; run(): Promise<void> }[] = [];
  const statuses: string[] = [];
  const published: string[] = [];
  const stops: string[] = [];
  const reloads: string[] = [];
  const threadEvents: Record<string, ((payload: unknown) => void)[]> = {};
  const disposers: (() => void | Promise<void>)[] = [];
  const migrationsApplied: string[] = [];
  let configured: ((ctx: unknown) => unknown) | null = null;
  const threadStatus: Record<string, string> = {};

  const bb = {
    pluginId: "mcp-hub",
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    storage: {
      database: () => db,
      migrate: (_db: unknown, statements: string[]) => {
        const already = (kv.get("migrations") as number | undefined) ?? 0;
        statements.slice(already).forEach((statement) => {
          db.exec(statement);
          migrationsApplied.push(statement.trim().slice(0, 40));
        });
        kv.set("migrations", statements.length);
      },
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async () => [...kv.keys()],
      },
    },
    http: { route: () => undefined },
    rpc: {
      register: (_contract: unknown, map: Record<string, (input: unknown) => unknown>) => {
        Object.assign(handlers, map);
      },
      experimental_invalidate: () => undefined,
      experimental_invalidateAll: () => undefined,
    },
    realtime: {
      publish: (channel: string) => {
        published.push(channel);
      },
    },
    background: {
      service: (name: string, service: { start(signal: AbortSignal): Promise<void> | void }) => {
        services.push({ name, start: service.start });
      },
      schedule: (name: string, cron: string, run: () => Promise<void>) => {
        schedules.push({ name, cron, run });
      },
    },
    cli: { register: (registration: unknown) => void registration },
    agents: {
      configure: (fn: (ctx: unknown) => unknown) => {
        configured = fn;
      },
      registerTool: (tool: RegisteredTool) => {
        if (tools.has(tool.name)) throw new Error(`${tool.name} is already registered`);
        tools.set(tool.name, tool);
      },
      contributeInstructions: () => undefined,
    },
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        (threadEvents[event] ??= []).push(handler);
      },
    },
    status: {
      needsConfiguration: (message: string) => {
        statuses.push(message);
      },
    },
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata[threadId] ?? {},
        updatePluginMetadata: async ({
          threadId,
          set,
        }: {
          threadId: string;
          set: Record<string, unknown>;
        }) => {
          metadata[threadId] = { ...(metadata[threadId] ?? {}), ...set };
          return metadata[threadId];
        },
        get: async ({ threadId }: { threadId: string }) => ({
          id: threadId,
          status: threadStatus[threadId] ?? "idle",
          projectId: "proj_personal",
        }),
        listRunning: async () => [],
        stop: async ({ threadId }: { threadId: string }) => {
          stops.push(threadId);
          return {};
        },
      },
      plugins: {
        reload: async ({ pluginId }: { pluginId?: string }) => {
          reloads.push(pluginId ?? "?");
          return {};
        },
      },
    },
    onDispose: (hook: () => void | Promise<void>) => {
      disposers.push(hook);
    },
    onInstall: () => undefined,
  } as unknown as BbPluginApi;

  return {
    bb,
    db,
    kv,
    metadata,
    tools,
    handlers,
    services,
    schedules,
    statuses,
    published,
    stops,
    reloads,
    threadEvents,
    disposers,
    migrationsApplied,
    threadStatus,
    configure: (ctx: unknown) => configured?.(ctx) as {
      tools: Array<string | { name: string; parameters: Record<string, unknown> }>;
      skills: string[];
      instructions?: string;
    },
    async start(): Promise<void> {
      await plugin(bb);
    },
  };
}

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

async function loaded() {
  const h = harness();
  await h.start();
  disposers.push(...h.disposers);
  return h;
}

describe("plugin wiring", () => {
  it("loads, migrates, and registers every surface", async () => {
    const h = await loaded();
    expect(h.migrationsApplied.length).toBeGreaterThan(10);
    expect(Object.keys(h.handlers).sort()).toEqual(
      [
        "calls",
        "oauth_complete",
        "oauth_resolve",
        "selection_get",
        "selection_set",
        "server_connect",
        "server_create",
        "server_disconnect",
        "server_enabled",
        "server_remove",
        "server_sync",
        "server_sync_all",
        "server_update",
        "snapshot",
        "tool_call",
        "tool_enabled",
      ].sort(),
    );
    expect(h.services.map((service) => service.name)).toEqual(["connections"]);
    expect(h.schedules.map((schedule) => schedule.name)).toEqual(["catalog-refresh"]);
    expect(h.kv.get("legacy-imported")).toBe(true);
    expect(h.tools.size).toBe(0);
  });

  it("registers nothing for an empty catalog, and still configures a thread", async () => {
    const h = await loaded();
    const configuration = h.configure({
      thread: { id: "t1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "proj_personal", kind: "personal", name: "Personal", gitRemoteUrl: null },
      pluginMetadata: {},
      provider: { id: "claude-code", model: "x", capabilities: { supportsNativeUserQuestion: true } },
      environment: { id: "e", name: null, path: null, branchName: null, workspaceProvisionType: null },
      host: { id: "h", name: "here" },
      origin: { kind: null, pluginId: null },
    });
    expect(configuration.tools).toEqual([]);
    expect(configuration.skills).toEqual(["mcp-hub"]);
  });

  it("adds a server, connects, registers its tools and calls one", async () => {
    const h = await loaded();

    const created = (await h.handlers.server_create({
      name: "Echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixture("echo-mcp-server.mjs")],
      auth: "none",
      enabled: true,
      connect: true,
    })) as { id: string; error: string | null };
    expect(created.error).toBeNull();
    expect(created.id).toBe("echo");
    expect(h.tools.has("echo_echo")).toBe(true);

    const configuration = h.configure({
      thread: { id: "t1", title: null, parentThreadId: null, sourceThreadId: null },
      project: { id: "proj_personal", kind: "personal", name: "Personal", gitRemoteUrl: null },
      pluginMetadata: {},
      provider: { id: "claude-code", model: "x", capabilities: { supportsNativeUserQuestion: true } },
      environment: { id: "e", name: null, path: null, branchName: null, workspaceProvisionType: null },
      host: { id: "h", name: "here" },
      origin: { kind: null, pluginId: null },
    });
    expect(configuration.tools).toHaveLength(1);
    const selected = configuration.tools[0];
    expect(typeof selected === "string" ? selected : selected.name).toBe("echo_echo");

    const result = (await h.tools.get("echo_echo")!.execute(
      { text: "hello" },
      { threadId: "t1", projectId: "proj_personal" },
    )) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });

    const calls = (await h.handlers.calls({ serverId: "echo", limit: 10 })) as {
      calls: Array<{ tool: string; ok: boolean; threadId: string | null }>;
    };
    expect(calls.calls[0]).toMatchObject({ tool: "echo", ok: true, threadId: "t1" });
  }, 20_000);

  it("saves a thread selection and restarts an idle session", async () => {
    const h = await loaded();
    await h.handlers.server_create({
      name: "Echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixture("echo-mcp-server.mjs")],
      auth: "none",
      enabled: true,
      connect: true,
    });

    const before = (await h.handlers.selection_get({ threadId: "t1" })) as {
      servers: Array<{ id: string; enabled: boolean; tools: Array<{ name: string; enabled: boolean }> }>;
      scope: string;
    };
    expect(before.scope).toBe("thread");
    expect(before.servers[0].tools[0]).toMatchObject({ name: "echo_echo", enabled: true });

    const saved = (await h.handlers.selection_set({
      threadId: "t1",
      servers: {},
      tools: { echo_echo: false },
      clearedServers: [],
      clearedTools: [],
      apply: true,
      interrupt: false,
    })) as { restarted: boolean; deferred: boolean; offered: number };
    expect(saved.restarted).toBe(true);
    expect(saved.deferred).toBe(false);
    expect(saved.offered).toBe(0);
    expect(h.stops).toEqual(["t1"]);

    // Off is immediate: the tool is still registered, and refuses.
    const refused = (await h.tools.get("echo_echo")!.execute(
      { text: "hello" },
      { threadId: "t1", projectId: "proj_personal" },
    )) as { isError: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("turned off for this thread");
  }, 20_000);

  it("defers a restart while the thread is mid-turn", async () => {
    const h = await loaded();
    h.threadStatus.t1 = "active";
    await h.handlers.server_create({
      name: "Echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixture("echo-mcp-server.mjs")],
      auth: "none",
      enabled: true,
      connect: true,
    });

    const saved = (await h.handlers.selection_set({
      threadId: "t1",
      servers: {},
      tools: { echo_echo: false },
      clearedServers: [],
      clearedTools: [],
      apply: true,
      interrupt: false,
    })) as { restarted: boolean; deferred: boolean };
    expect(saved).toEqual({ restarted: false, deferred: true, truncated: false, offered: 0 });
    expect(h.stops).toEqual([]);

    // The turn ends; the stop happens then.
    h.threadStatus.t1 = "idle";
    for (const handler of h.threadEvents["thread.idle"] ?? []) handler({ thread: { id: "t1" } });
    await expect.poll(() => h.stops, { timeout: 2000 }).toEqual(["t1"]);
  }, 20_000);

  it("drops a server, its tools and its secrets", async () => {
    const h = await loaded();
    await h.handlers.server_create({
      name: "Echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixture("echo-mcp-server.mjs")],
      auth: "none",
      enabled: true,
      connect: true,
    });
    await h.handlers.server_remove({ id: "echo" });
    const snapshot = (await h.handlers.snapshot({})) as { servers: unknown[]; tools: unknown[] };
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.tools).toEqual([]);
  }, 20_000);

  it("reports a failed connection on the row instead of throwing", async () => {
    const h = await loaded();
    const created = (await h.handlers.server_create({
      name: "Broken",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      args: [],
      auth: "none",
      enabled: true,
      connect: true,
    })) as { id: string; error: string | null };
    expect(created.error).not.toBeNull();
    const snapshot = (await h.handlers.snapshot({})) as {
      servers: Array<{ id: string; state: string; error: string | null }>;
    };
    expect(snapshot.servers[0]).toMatchObject({ id: "broken", state: "failed" });
    expect(snapshot.servers[0].error).toBeTruthy();
  }, 20_000);
});
