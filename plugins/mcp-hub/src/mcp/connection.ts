// One live MCP client per configured server, and the state each one is in.
//
// The rule this file exists to keep: a JSON-RPC error is not a dead
// connection. A server that answers `-32602 Invalid params` is working
// exactly as designed, and the old plugin dropped its client - and, for
// stdio, killed the child process other threads were still calling - every
// time a model passed a bad argument. Only a transport-level failure tears a
// connection down here; protocol errors travel back as tool results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  McpError,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { DiscoveredTool, ServerRecord } from "../storage/store.js";
import type { SecretStore } from "../storage/secrets.js";
import { createOAuthProvider, storedRedirectUri, type HubOAuthProvider } from "./oauth.js";
import { authHeaders, createHttpTransport, describeHttpFailure } from "./http.js";
import type { StdioSupervisor } from "./stdio.js";

export type ConnectionState = "idle" | "connecting" | "ready" | "needs-auth" | "failed";

export interface ServerStatus {
  serverId: string;
  state: ConnectionState;
  protocol: "stdio" | "http" | "sse" | null;
  toolCount: number | null;
  error: string | null;
  authorizationUrl: string | null;
  lastSeenAt: number | null;
}

export interface McpConnection {
  server: ServerRecord;
  client: Client;
  transport: Transport;
  protocol: "stdio" | "http" | "sse";
}

export interface ConnectOptions {
  /** The origin the panel is on, when a browser started this. */
  origin?: string;
}

export interface ConnectionManager {
  status(serverId: string): ServerStatus;
  statuses(): ServerStatus[];
  /** A live client, or null. */
  client(serverId: string): Client | null;
  ensure(server: ServerRecord, options?: ConnectOptions): Promise<McpConnection>;
  /** Connects, lists the tools, and returns them as the store wants them. */
  discover(server: ServerRecord, options?: ConnectOptions): Promise<DiscoveredTool[]>;
  /** Completes a flow with the code the browser came back with. */
  finishAuth(server: ServerRecord, code: string, origin?: string): Promise<void>;
  close(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Marks a server's grant dead and forgets the live client. */
  markNeedsAuth(serverId: string, message: string): Promise<void>;
}

export interface ConnectionDeps {
  secrets: SecretStore;
  stdio: StdioSupervisor;
  log: { warn(message: string): void; info?(message: string): void };
  /** Fired when a server says its tool list changed. */
  onToolsChanged(serverId: string): void;
  fetch?: typeof fetch;
  now?: () => number;
}

const CLIENT_INFO = { name: "bb-mcp-hub", version: "0.2.0" };

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
    return error.message;
  }
  return String(error);
}

/** A JSON-RPC error the server chose to send, as opposed to a dead pipe. */
export function isProtocolError(error: unknown): error is McpError {
  return error instanceof McpError;
}

export function toolFromWire(tool: Tool): DiscoveredTool {
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : null,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema:
      tool.inputSchema !== null && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object" },
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

export function createConnectionManager(deps: ConnectionDeps): ConnectionManager {
  const now = deps.now ?? Date.now;
  const connections = new Map<string, McpConnection>();
  const pending = new Map<string, Promise<McpConnection>>();
  const statuses = new Map<string, ServerStatus>();

  function statusOf(serverId: string): ServerStatus {
    return (
      statuses.get(serverId) ?? {
        serverId,
        state: "idle",
        protocol: null,
        toolCount: null,
        error: null,
        authorizationUrl: null,
        lastSeenAt: null,
      }
    );
  }

  function setStatus(serverId: string, change: Partial<ServerStatus>): void {
    statuses.set(serverId, { ...statusOf(serverId), ...change });
  }

  function oauthProviderFor(server: ServerRecord, origin?: string): HubOAuthProvider | undefined {
    if (server.auth !== "oauth") return undefined;
    const redirectUri = origin
      ? `${origin.replace(/\/+$/, "")}/plugins/mcp-hub/mcp-hub/oauth/callback`
      : (storedRedirectUri(deps.secrets, server.id) ?? "");
    if (!redirectUri) return undefined;
    const secrets = deps.secrets.get(server.id);
    const staticClient =
      server.oauthClientId !== null
        ? { clientId: server.oauthClientId, clientSecret: secrets.oauthClientSecret ?? null }
        : undefined;
    return createOAuthProvider({
      serverId: server.id,
      redirectUri,
      secrets: deps.secrets,
      staticClient,
      scopes: server.oauthScopes,
    });
  }

  async function open(
    server: ServerRecord,
    protocol: "stdio" | "http" | "sse",
    authProvider?: OAuthClientProvider,
  ): Promise<McpConnection> {
    const secrets = deps.secrets.get(server.id);
    const transport =
      protocol === "stdio"
        ? await deps.stdio.transportFor(server, secrets.env ?? {})
        : createHttpTransport({
            server,
            protocol,
            headers: authHeaders(server, secrets),
            authProvider,
            fetch: deps.fetch,
          });

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    let closed = false;

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      deps.onToolsChanged(server.id);
    });

    const connection: McpConnection = { server, client, transport, protocol };

    transport.onclose = () => {
      if (closed) return;
      const live = connections.get(server.id);
      if (live !== connection) return;
      connections.delete(server.id);
      setStatus(server.id, {
        state: "failed",
        error: `${server.name} closed the connection`,
      });
    };

    try {
      await client.connect(transport);
    } catch (error) {
      closed = true;
      connections.delete(server.id);
      try {
        await transport.close();
      } catch {
        // Already gone; the original error is the one worth reporting.
      }
      throw error;
    }

    closed = false;
    connections.set(server.id, connection);
    const existingTools = statuses.get(server.id)?.toolCount ?? null;
    setStatus(server.id, {
      state: "ready",
      protocol,
      error: null,
      authorizationUrl: null,
      lastSeenAt: now(),
      toolCount: existingTools,
    });
    return connection;
  }

  async function connect(server: ServerRecord, options: ConnectOptions = {}): Promise<McpConnection> {
    setStatus(server.id, { state: "connecting", error: null });
    const provider = oauthProviderFor(server, options.origin);

    if (server.transport === "stdio") {
      return open(server, "stdio");
    }

    try {
      return await open(server, "http", provider);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw Object.assign(new Error("Sign in required"), {
          name: "NeedsAuthorizationError",
          authorizationUrl: provider?.authorizationUrl ?? null,
        });
      }
      // A streamable probe that fails on the transport may be a server that
      // only speaks SSE. One fallback, then report the streamable error,
      // which is the one about the protocol the user's server claims.
      try {
        return await open(server, "sse", provider);
      } catch (fallbackError) {
        if (fallbackError instanceof UnauthorizedError) {
          throw Object.assign(new Error("Sign in required"), {
            name: "NeedsAuthorizationError",
            authorizationUrl: provider?.authorizationUrl ?? null,
          });
        }
        throw Object.assign(new Error(describeHttpFailure(error)), {
          name: "ConnectionFailedError",
          stderr: deps.stdio.stderrTail(server.id),
        });
      }
    }
  }

  function ensure(server: ServerRecord, options: ConnectOptions = {}): Promise<McpConnection> {
    const existing = connections.get(server.id);
    if (existing) return Promise.resolve(existing);
    const inFlight = pending.get(server.id);
    if (inFlight) return inFlight;

    const attempt = connect(server, options)
      .then((connection) => {
        pending.delete(server.id);
        return connection;
      })
      .catch((error: unknown) => {
        pending.delete(server.id);
        const name = (error as { name?: string }).name;
        if (name === "NeedsAuthorizationError") {
          setStatus(server.id, {
            state: "needs-auth",
            error: "Sign in required",
            authorizationUrl: (error as { authorizationUrl?: string | null }).authorizationUrl ?? null,
          });
        } else {
          setStatus(server.id, { state: "failed", error: errorMessage(error) });
        }
        throw error;
      });
    pending.set(server.id, attempt);
    return attempt;
  }

  async function discover(server: ServerRecord, options: ConnectOptions = {}): Promise<DiscoveredTool[]> {
    const connection = await ensure(server, options);
    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await connection.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) tools.push(toolFromWire(tool));
      cursor = page.nextCursor;
    } while (cursor);

    setStatus(server.id, { toolCount: tools.length, lastSeenAt: now(), state: "ready", error: null });
    return tools;
  }

  async function finishAuth(server: ServerRecord, code: string, origin?: string): Promise<void> {
    const provider = oauthProviderFor(server, origin);
    if (!provider) throw new Error(`"${server.name}" is not configured for OAuth.`);
    if (!server.url) throw new Error(`"${server.name}" has no URL.`);
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: code,
      fetchFn: deps.fetch ? (input, init) => deps.fetch!(input, init) : undefined,
    });
    if (result !== "AUTHORIZED") {
      throw new Error("The authorization server did not accept this sign-in.");
    }
    await close(server.id);
    setStatus(server.id, { state: "idle", error: null, authorizationUrl: null });
  }

  async function close(serverId: string): Promise<void> {
    const connection = connections.get(serverId);
    connections.delete(serverId);
    if (!connection) return;
    try {
      await connection.transport.close();
    } catch {
      // The transport is being thrown away either way.
    }
  }

  async function closeAll(): Promise<void> {
    await Promise.all([...connections.keys()].map((serverId) => close(serverId)));
  }

  async function markNeedsAuth(serverId: string, message: string): Promise<void> {
    await close(serverId);
    setStatus(serverId, { state: "needs-auth", error: message, toolCount: null });
  }

  return {
    status: statusOf,
    statuses: () => [...statuses.values()],
    client: (serverId) => connections.get(serverId)?.client ?? null,
    ensure,
    discover,
    finishAuth,
    close,
    closeAll,
    markNeedsAuth,
  };
}
