// The domain layer: everything a server, a selection or a catalog *is*.
//
// No transport, no RPC, no UI. server.ts builds it, rpc.ts and cli.ts call it,
// and the background service drives it. That keeps the three surfaces from
// each growing their own version of "add a server".
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { slugify, uniqueId } from "../mcp/naming.js";
import type { ServerSecrets } from "../storage/secrets.js";
import type { SecretStore } from "../storage/secrets.js";
import type { ServerRecord, Store, ToolRecord } from "../storage/store.js";
import type { ConnectionManager } from "../mcp/connection.js";
import type { ExecuteOutcome } from "../mcp/execute.js";
import { executeTool } from "../mcp/execute.js";
import type { ServerInput, ServerView, Snapshot, ToolView } from "../../contract.js";
import { oauthRedirectUriFor } from "../../contract.js";
import { resolveSelection } from "./selection.js";
import { storedRedirectUri } from "../mcp/oauth.js";

export interface Restarter {
  apply(threadId: string, interrupt: boolean): Promise<{ restarted: boolean; deferred: boolean }>;
}

export function createRestarter(bb: BbPluginApi): Restarter {
  const waiting = new Set<string>();

  bb.events.on("thread.idle", ({ thread }) => {
    if (!waiting.has(thread.id)) return;
    waiting.delete(thread.id);
    void bb.sdk.threads.stop({ threadId: thread.id }).catch(() => undefined);
  });

  return {
    async apply(threadId, interrupt) {
      let busy = false;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const status = (thread as { status?: string }).status;
        busy = status === "active" || status === "starting" || status === "stopping" || status === "pending";
      } catch {
        // An unknown thread cannot be restarted, and nothing depends on it.
        return { restarted: false, deferred: false };
      }
      if (busy && !interrupt) {
        waiting.add(threadId);
        return { restarted: false, deferred: true };
      }
      waiting.delete(threadId);
      try {
        await bb.sdk.threads.stop({ threadId });
      } catch {
        // A thread that is already released needs no stop; the new selection
        // applies to the session the next message constructs.
      }
      return { restarted: true, deferred: false };
    },
  };
}

export interface HubDeps {
  store: Store;
  secrets: SecretStore;
  connections: ConnectionManager;
  restarter: Restarter;
  /** Every name this plugin registered with BB, for selection filtering. */
  registered(): ReadonlySet<string>;
  /** Registers cached tools that are not registered yet; returns new names. */
  registerTools(): string[];
  /** A tool BB refused to register, by name. */
  toolProblem(name: string): string | null;
  /** Called after anything a client should see change. */
  publish(): void;
  log: { warn(message: string): void };
}

export interface Hub {
  snapshot(origin?: string): Snapshot;
  createServer(input: ServerInput, origin?: string): Promise<{ id: string; authorizationUrl: string | null; error: string | null }>;
  updateServer(input: ServerInput, origin?: string): Promise<{ id: string; authorizationUrl: string | null; error: string | null }>;
  removeServer(id: string): Promise<void>;
  setServerEnabled(id: string, enabled: boolean): void;
  sync(server: ServerRecord, origin?: string): Promise<{ tools: number; added: string[]; changed: boolean }>;
  syncById(id: string, origin?: string): Promise<{ tools: number; added: string[]; changed: boolean }>;
  syncAll(): Promise<{ servers: number; tools: number; failed: number }>;
  connect(id: string, origin?: string): Promise<{ state: ServerView["state"]; authorizationUrl: string | null; tools: number; error: string | null }>;
  disconnect(id: string): Promise<void>;
  completeOAuth(id: string, code: string, origin?: string): Promise<{ tools: number; error: string | null }>;
  /** The server a callback's `state` belongs to, or null. */
  resolveOAuthState(state: string): string | null;
  setToolEnabled(names: string[], enabled: boolean): number;
  runTool(request: { serverId: string; tool: string; arguments: unknown; threadId?: string }): Promise<ExecuteOutcome>;
  calls(serverId: string, limit: number): ReturnType<Store["listCalls"]>;
  /** Stops a thread so its next message builds a session from the current switches. */
  restartThread(threadId: string, interrupt: boolean): Promise<{ restarted: boolean; deferred: boolean }>;
}

function cleanArgs(args: string[] | undefined): string[] {
  return (args ?? []).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

export function createHub(bb: BbPluginApi, deps: HubDeps): Hub {
  const { store, secrets, connections, restarter } = deps;

  function secretFlags(id: string): {
    hasBearer: boolean;
    hasHeaders: boolean;
    hasEnv: boolean;
    hasOAuthClientSecret: boolean;
  } {
    const stored = secrets.get(id);
    return {
      hasBearer: Boolean(stored.bearer),
      hasHeaders: Object.keys(stored.headers ?? {}).length > 0,
      hasEnv: Object.keys(stored.env ?? {}).length > 0,
      hasOAuthClientSecret: Boolean(stored.oauthClientSecret),
    };
  }

  function serverView(server: ServerRecord, origin?: string): ServerView {
    const status = connections.status(server.id);
    const flags = secretFlags(server.id);
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      auth: server.auth,
      oauthClientId: server.oauthClientId,
      oauthScopes: server.oauthScopes,
      enabled: server.enabled,
      createdAt: server.createdAt,
      lastSeenAt: server.lastSeenAt,
      ...flags,
      redirectUri: origin ? oauthRedirectUriFor(origin) : null,
      registeredRedirectUri: storedRedirectUri(secrets, server.id),
      state: status.state,
      protocol: status.protocol,
      toolCount: status.toolCount ?? store.listTools(server.id).filter((tool) => !tool.missing).length,
      error: status.error,
      authorizationUrl: status.authorizationUrl,
    };
  }

  function toolView(tool: ToolRecord): ToolView {
    return {
      serverId: tool.serverId,
      name: tool.name,
      upstreamName: tool.upstreamName,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly,
      enabled: tool.enabled,
      missing: tool.missing,
      problem: deps.toolProblem(tool.name),
    };
  }

  function snapshot(origin?: string): Snapshot {
    const selection = resolveSelection(store, deps.registered());
    return {
      servers: store.listServers().map((server) => serverView(server, origin)),
      tools: store.listTools().map(toolView),
      problems: store
        .listTools()
        .map((tool) => ({ name: tool.name, reason: deps.toolProblem(tool.name) }))
        .filter((problem): problem is { name: string; reason: string } => problem.reason !== null),
      offered: selection.offered,
      truncated: selection.truncated,
    };
  }

  function validateInput(input: ServerInput): void {
    if (input.transport === "stdio") {
      if (!input.command?.trim()) throw new Error("A local command needs a command to run.");
      if (input.url?.trim()) throw new Error("A local command has no URL.");
    } else {
      if (!input.url?.trim()) throw new Error("A remote server needs a URL.");
      let parsed: URL;
      try {
        parsed = new URL(input.url.trim());
      } catch {
        throw new Error (`"${input.url}" is not a URL.`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("A remote MCP server URL must be http or https.");
      }
      if (!input.auth) throw new Error("Choose how this server authenticates.");
    }
  }

  /** Writes only the credential fields the form actually supplied. */
  function writeSecrets(id: string, input: ServerInput): void {
    secrets.update(id, (current) => {
      const next: ServerSecrets = { ...current };
      if (input.bearer !== undefined) {
        if (input.bearer === "") delete next.bearer;
        else next.bearer = input.bearer;
      }
      if (input.headers !== undefined) {
        next.headers = Object.fromEntries(
          Object.entries(input.headers).filter(([, value]) => value.trim().length > 0),
        );
      }
      if (input.env !== undefined) {
        next.env = Object.fromEntries(
          Object.entries(input.env).filter(([, value]) => value.trim().length > 0),
        );
      }
      if (input.oauthClientSecret !== undefined) {
        if (input.oauthClientSecret === "") delete next.oauthClientSecret;
        else next.oauthClientSecret = input.oauthClientSecret;
      }
      return next;
    });
  }

  async function sync(server: ServerRecord, origin?: string) {
    const discovered = await connections.discover(server, { origin });
    const changed = store.syncTools(server.id, discovered, Date.now());
    const added = deps.registerTools();
    deps.publish();
    return { tools: discovered.length, added, changed };
  }

  async function connect(server: ServerRecord, origin?: string) {
    try {
      const tools = await connections.discover(server, { origin });
      store.syncTools(server.id, tools, Date.now());
      deps.registerTools();
      deps.publish();
      return { state: "ready" as const, authorizationUrl: null, tools: tools.length, error: null };
    } catch (error) {
      const status = connections.status(server.id);
      deps.publish();
      return {
        state: status.state,
        authorizationUrl: status.authorizationUrl,
        tools: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    snapshot,

    async createServer(input, origin) {
      validateInput(input);
      const taken = new Set(store.listServers().map((server) => server.id));
      const id = uniqueId(slugify(input.name), taken);
      const record: ServerRecord = {
        id,
        name: input.name.trim(),
        transport: input.transport,
        url: input.transport === "http" ? (input.url?.trim() ?? null) : null,
        command: input.transport === "stdio" ? (input.command ?? "").trim() : null,
        args: cleanArgs(input.args),
        cwd: input.cwd?.trim() ? input.cwd.trim() : null,
        auth: input.transport === "http" ? input.auth : "none",
        oauthClientId: input.oauthClientId?.trim() ? input.oauthClientId.trim() : null,
        oauthScopes: input.oauthScopes?.trim() ? input.oauthScopes.trim() : null,
        enabled: input.enabled,
        createdAt: Date.now(),
        lastSeenAt: null,
      };
      store.saveServer(record);
      writeSecrets(id, input);
      deps.publish();
      if (!input.connect || !record.enabled) {
        return { id, authorizationUrl: null, error: null };
      }
      const result = await connect(record, origin);
      return { id, authorizationUrl: result.authorizationUrl, error: result.error };
    },

    async updateServer(input, origin) {
      if (!input.id) throw new Error("No server to update.");
      const existing = store.getServer(input.id);
      if (!existing) throw new Error("That server no longer exists.");
      validateInput(input);
      const record: ServerRecord = {
        ...existing,
        name: input.name.trim(),
        transport: input.transport,
        url: input.transport === "http" ? (input.url?.trim() ?? null) : null,
        command: input.transport === "stdio" ? (input.command ?? "").trim() : null,
        args: cleanArgs(input.args),
        cwd: input.cwd?.trim() ? input.cwd.trim() : null,
        auth: input.transport === "http" ? input.auth : "none",
        oauthClientId: input.oauthClientId?.trim() ? input.oauthClientId.trim() : null,
        oauthScopes: input.oauthScopes?.trim() ? input.oauthScopes.trim() : null,
        enabled: input.enabled,
      };
      store.saveServer(record);
      writeSecrets(record.id, input);
      // Headers, a token, a command or a URL all live in the transport this
      // closed connection was built with, so it cannot be reused.
      await connections.close(record.id);
      deps.publish();
      if (!input.connect || !record.enabled) {
        return { id: record.id, authorizationUrl: null, error: null };
      }
      const result = await connect(record, origin);
      return { id: record.id, authorizationUrl: result.authorizationUrl, error: result.error };
    },

    async removeServer(id) {
      await connections.close(id);
      secrets.remove(id);
      store.removeServer(id);
      deps.publish();
    },

    setServerEnabled(id, enabled) {
      store.setServerEnabled(id, enabled);
      deps.publish();
    },

    sync,

    async syncById(id, origin) {
      const server = store.getServer(id);
      if (!server) throw new Error("That server no longer exists.");
      return sync(server, origin);
    },

    async syncAll() {
      let servers = 0;
      let tools = 0;
      let failed = 0;
      for (const server of store.listServers()) {
        if (!server.enabled) continue;
        try {
          const result = await sync(server);
          servers += 1;
          tools += result.tools;
        } catch (error) {
          failed += 1;
          deps.log.warn(`Could not read tools from "${server.name}": ${String(error)}`);
        }
      }
      return { servers, tools, failed };
    },

    async connect(id, origin) {
      const server = store.getServer(id);
      if (!server) throw new Error("That server no longer exists.");
      const result = await connect(server, origin);
      return result;
    },

    async disconnect(id) {
      await connections.close(id);
      deps.publish();
    },

    resolveOAuthState(state) {
      return secrets.findByOAuthState(state);
    },

    async completeOAuth(id, code, origin) {
      const server = store.getServer(id);
      if (!server) throw new Error("That server no longer exists.");
      try {
        await connections.finishAuth(server, code, origin);
        const tools = await connections.discover(server, { origin });
        store.syncTools(server.id, tools, Date.now());
        deps.registerTools();
        deps.publish();
        return { tools: tools.length, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.publish();
        return { tools: 0, error: message };
      }
    },

    setToolEnabled(names, enabled) {
      const updated = store.setToolsEnabled(names, enabled);
      deps.publish();
      return updated;
    },

    async runTool(request) {
      const server = store.getServer(request.serverId);
      if (!server) throw new Error("That server no longer exists.");
      const tool = store
        .listTools(server.id)
        .find((candidate) => candidate.name === request.tool || candidate.upstreamName === request.tool);
      if (!tool) throw new Error(`"${request.tool}" is not a tool on "${server.name}".`);
      const outcome = await executeTool({ connections }, { server, tool, arguments: request.arguments });
      store.recordCall({
        at: Date.now(),
        serverId: server.id,
        tool: tool.upstreamName,
        threadId: request.threadId ?? null,
        ok: outcome.failure === null && !outcome.result.isError,
        durationMs: outcome.durationMs,
        error: outcome.failure,
      });
      if (outcome.needsAuth) deps.publish();
      return outcome;
    },

    calls(serverId, limit) {
      return store.listCalls(serverId, limit);
    },

    async restartThread(threadId, interrupt) {
      return restarter.apply(threadId, interrupt);
    },
  };
}
