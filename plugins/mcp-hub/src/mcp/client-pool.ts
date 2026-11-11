import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerRecord } from "../storage/registry.js";
import { toBbContent } from "./content.js";
import { flattenSchema, RecursiveSchemaError } from "./schema-tools.js";
import { describeTransportFailure } from "./transport.js";

/**
 * One client per configured MCP server, shared by every thread in this BB
 * server process.
 *
 * The transport is injected (`ClientPoolDeps.createTransport`) rather than
 * built here, so tests can hand the pool an in-memory transport pair
 * instead of opening a real network connection, and so other transport
 * kinds (stdio, OAuth-authenticated HTTP) can be added later without
 * touching this file.
 *
 * Clients are cached by `server.id` in a `Map<string, Promise<Client>>`
 * rather than `Map<string, Client>` so that concurrent callers racing to
 * use a not-yet-connected server share the single in-flight `connect()`
 * call instead of each opening their own connection.
 */

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface McpCallResult {
  content: PluginAgentToolContentPart[];
  isError: boolean;
}

export interface ClientPool {
  listTools(server: ServerRecord): Promise<DiscoveredTool[]>;
  callTool(
    server: ServerRecord,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult>;
  close(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ClientPoolDeps {
  /**
   * Injected so tests can supply an in-memory transport. `headers` carries
   * whatever {@link ClientPoolDeps.getAuthHeader} produced; a stdio transport
   * ignores it.
   */
  /**
   * `resolveAuthHeaders` is handed to the transport rather than called here,
   * so an HTTP transport can resolve the bearer on every REQUEST instead of
   * once per connection. A pooled client can outlive several token lifetimes,
   * and a header fixed at construction cannot be corrected afterwards.
   */
  createTransport(
    server: ServerRecord,
    resolveAuthHeaders: () => Promise<Record<string, string>>,
  ): Promise<Transport>;
  /**
   * The bearer header for a remote server.
   *
   * The whole record rather than the id: a stored token belongs to the URL it
   * was issued for, and the id alone cannot tell a re-added server pointing
   * somewhere else from the one the grant came from.
   */
  getAuthHeader?(server: ServerRecord): Promise<Record<string, string>>;
  log: { warn(message: string): void; info(message: string): void };
}

/**
 * JSON-RPC code the MCP SDK's own client-side timer rejects with. The timer
 * lives in the client, not the transport: it firing means this side gave up,
 * not that the connection died.
 */
const REQUEST_TIMEOUT_CODE = -32001;

/**
 * Whether a failure came from THIS side giving up rather than from the
 * connection breaking.
 *
 * An `AbortSignal` rejects with its `reason`, which for a plain `abort()` is a
 * `DOMException` named "AbortError"; the SDK's request timeout rejects with an
 * `McpError` carrying {@link REQUEST_TIMEOUT_CODE}.
 */
export function isCallerCancellation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return true;
  return candidate.code === REQUEST_TIMEOUT_CODE;
}

export function createClientPool(deps: ClientPoolDeps): ClientPool {
  const clients = new Map<string, Promise<Client>>();

  async function connect(server: ServerRecord): Promise<Client> {
    const transport = await deps.createTransport(
      server,
      async () => (await deps.getAuthHeader?.(server)) ?? {},
    );
    const client = new Client({ name: "bb-plugin-mcp-hub", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      // The handshake is where a wrong URL shows up - `initialize` is the
      // first POST - and it never reaches `withClient`'s catch below, because
      // connecting happens before that try block.
      throw describeTransportFailure(server, error);
    }
    return client;
  }

  function getClient(server: ServerRecord): Promise<Client> {
    const cached = clients.get(server.id);
    if (cached) return cached;

    const pending = connect(server);
    clients.set(server.id, pending);
    // A failed connection attempt must not stay cached: drop it so the next
    // call tries again instead of forever awaiting a rejected promise.
    pending.catch(() => {
      if (clients.get(server.id) === pending) clients.delete(server.id);
    });
    return pending;
  }

  async function dropClient(serverId: string): Promise<void> {
    const pending = clients.get(serverId);
    clients.delete(serverId);
    if (!pending) return;
    try {
      const client = await pending;
      await client.close();
    } catch {
      // The connection was already broken; there is nothing left to close.
    }
  }

  /**
   * Runs `fn` against the pooled client for `server`. On a TRANSPORT failure -
   * connect or in-flight request - the cached client is dropped so the next
   * call reconnects from scratch. No backoff: a single user on one process
   * cannot stampede a server.
   *
   * A caller-side cancellation is deliberately not such a failure. This pool
   * is process-wide, and `dropClient` on a stdio server kills the shared child
   * process group: one thread whose user pressed stop, or one call that
   * outran `CALL_TIMEOUT_MS`, would otherwise tear down every OTHER thread's
   * in-flight call against the same server and discard whatever state a
   * stateful server (one browser, one session) was holding. Neither says
   * anything about the connection being broken, so neither drops it.
   */
  async function withClient<T>(
    server: ServerRecord,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = await getClient(server);
    try {
      return await fn(client);
    } catch (error) {
      if (isCallerCancellation(error)) throw error;
      const described = describeTransportFailure(server, error);
      deps.log.warn(
        `MCP client for "${server.id}" failed, dropping cached connection: ${String(described)}`,
      );
      await dropClient(server.id);
      throw described;
    }
  }

  return {
    async listTools(server: ServerRecord): Promise<DiscoveredTool[]> {
      return withClient(server, async (client) => {
        const { tools } = await client.listTools();
        const usable: DiscoveredTool[] = [];
        for (const tool of tools) {
          let inputSchema: Record<string, unknown>;
          try {
            inputSchema = flattenSchema(tool.inputSchema);
          } catch (error) {
            // Design section 6: a cyclic schema cannot be flattened, so skip
            // the tool and say so. Letting it escape would fail tools/list for
            // the WHOLE server - one self-referencing $defs node (a file tree,
            // a generic JSON-value schema) would register zero of its twenty
            // tools, every seventeen minutes, with no way to exclude the one
            // at fault.
            if (!(error instanceof RecursiveSchemaError)) throw error;
            deps.log.warn(
              `MCP server "${server.id}" offers "${tool.name}" with a schema that `
              + `cannot be flattened, so that tool is skipped: ${error.message}`,
            );
            continue;
          }
          usable.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema,
            readOnly: tool.annotations?.readOnlyHint ?? false,
          });
        }
        return usable;
      });
    },

    async callTool(
      server: ServerRecord,
      toolName: string,
      args: Record<string, unknown>,
      options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<McpCallResult> {
      return withClient(server, async (client) => {
        const result = await client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { signal: options.signal, timeout: options.timeoutMs },
        );
        return {
          content: toBbContent(result.content, result.structuredContent),
          isError: typeof result.isError === "boolean" ? result.isError : false,
        };
      });
    },

    async close(serverId: string): Promise<void> {
      await dropClient(serverId);
    },

    async closeAll(): Promise<void> {
      await Promise.all(Array.from(clients.keys()).map((id) => dropClient(id)));
    },
  };
}
