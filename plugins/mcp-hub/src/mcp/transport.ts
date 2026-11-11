import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerRecord } from "../storage/registry.js";
import type { StdioSupervisor } from "./stdio.js";

/**
 * Builds the production HTTP transport for a server record.
 *
 * Kept separate from the client pool so the pool's `createTransport` hook can
 * be swapped for an in-memory pair in tests, and so future transports
 * (stdio, OAuth-authenticated HTTP) can be added as siblings without
 * touching the pool itself.
 *
 * `resolveAuthHeaders` is a function, not a value, and that is the whole
 * design. `StreamableHTTPClientTransport` reads `requestInit.headers` once per
 * request but the object it reads is fixed at construction, so a pooled client
 * built with a bearer token goes on sending that exact token for as long as it
 * is cached - past the token's expiry, and there is no way to reach inside a
 * live connection and correct it. Resolving per request instead means a token
 * that went stale while the client sat idle is refreshed before the request
 * that needed it, so the expiry is never visible to a caller. `accessToken`
 * already refreshes at three quarters of the quoted lifetime; this is what
 * lets that work reach a connection that was opened an hour ago.
 */
export function createHttpTransport(
  server: ServerRecord,
  resolveAuthHeaders: () => Promise<Record<string, string>>,
): StreamableHTTPClientTransport {
  if (!server.url) {
    throw new Error(`Server "${server.id}" has no URL configured for HTTP transport`);
  }
  return new StreamableHTTPClientTransport(new URL(server.url), {
    // The server's own static headers still go through `requestInit`, so they
    // are visible to the SDK's own header handling; the minted ones are
    // layered on top per request below.
    requestInit: Object.keys(server.headers).length > 0
      ? { headers: { ...server.headers } }
      : undefined,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      // `set`, not `append`: this is the same precedence `mergeHeaders`
      // states - a bearer this plugin minted outranks one that was typed in,
      // because only one of the two is still being kept alive.
      for (const [name, value] of Object.entries(await resolveAuthHeaders())) {
        headers.set(name, value);
      }
      return fetch(url, { ...init, headers });
    },
  });
}

/**
 * The server's own configured headers with the OAuth-derived ones on top.
 *
 * Still the statement of precedence even though the transport now layers the
 * two per request: this is where the rule is written down and tested.
 *
 * That order, and not the reverse: the bearer token is minted and refreshed by
 * this plugin, so on a collision it is the live value and a typed-in
 * `Authorization` is whatever was true when it was typed. A server with no
 * grant gets an empty `authHeaders` and keeps its own header either way.
 *
 * Separate from the transport so the precedence can be tested without opening
 * a connection: `StreamableHTTPClientTransport` keeps its `requestInit`
 * private.
 */
export function mergeHeaders(
  server: ServerRecord,
  authHeaders: Record<string, string>,
): Record<string, string> {
  return { ...server.headers, ...authHeaders };
}

/**
 * Builds the production stdio transport for a server record.
 *
 * The actual process supervision (spawning, env/PATH resolution, stderr
 * capture, kill lifecycle) lives in `StdioSupervisor`; this sibling just
 * delegates to it so `createTransport` callers can pick a factory by
 * `server.transport` without knowing about stdio process management.
 */
export function createStdioTransport(
  server: ServerRecord,
  supervisor: StdioSupervisor,
): Promise<Transport> {
  return supervisor.transportFor(server);
}

/**
 * Marks an error this module has already rewritten, so one that passes through
 * both the connect path and a caller's catch is not described twice.
 */
const DESCRIBED = Symbol("mcp.transport.described");

/**
 * The HTTP status a transport failure carries, or `null` when it is not an
 * HTTP failure at all.
 *
 * Both `code` and `status` are read because the SDK's `StreamableHTTPError`
 * puts the status on `code`, while a `fetch`-level wrapper is as likely to use
 * `status`. The 4xx/5xx range check is what keeps a JSON-RPC error code - the
 * SDK's own request timeout is `code: -32001` - from being read as a status.
 */
function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; status?: unknown };
  for (const value of [candidate.code, candidate.status]) {
    if (typeof value === "number" && value >= 400 && value < 600) return value;
  }
  return null;
}

/** Whatever the server said, with the SDK's own wrapping peeled off. */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Streamable HTTP error: /, "")
    .replace(/^Error POSTing to endpoint: /, "")
    .trim()
    .slice(0, 200);
}

/** Whether a URL names no path, so `/mcp` would be the thing it is missing. */
function isRootPath(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
}

/**
 * Rewrites an HTTP transport failure into something a user can act on.
 *
 * The SDK reports a failed POST as `Error POSTing to endpoint: ${body}`, which
 * for a server that answers with an empty body - a 405 from a host that serves
 * MCP on a path, say - is a sentence ending in a colon and nothing else. The
 * status is on the error object the whole time; this puts it in the message,
 * and names the likeliest cause when the URL has no path at all.
 *
 * `code` and `status` are carried onto the replacement because a 401 is not
 * just a message: `isUnauthorized` reads them to decide whether to refresh the
 * token and retry. Anything that is not an HTTP failure - a stdio server, a
 * dropped socket, a cancelled call - comes back untouched.
 */
export function describeTransportFailure(
  server: ServerRecord,
  error: unknown,
): unknown {
  if (typeof error === "object" && error !== null
    && (error as Record<symbol, unknown>)[DESCRIBED] === true) {
    return error;
  }
  const status = httpStatus(error);
  if (status === null || server.transport !== "http" || server.url === null) return error;
  const detail = failureDetail(error);
  const hint = (status === 404 || status === 405) && isRootPath(server.url)
    ? " An MCP server usually listens on a path such as /mcp rather than on the "
      + "site root, so this URL may be missing one."
    : "";
  return Object.assign(
    new Error(
      `MCP server "${server.displayName}" answered ${server.url} with HTTP ${status}`
      + `${detail === "" ? " and an empty body" : `: ${detail}`}.${hint}`,
    ),
    { code: status, status, cause: error, [DESCRIBED]: true },
  );
}
