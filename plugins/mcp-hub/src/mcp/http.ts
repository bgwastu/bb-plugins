// The two HTTP transports a remote MCP server can be spoken to over.
// Streamable HTTP is the current protocol; SSE is the older one, and enough
// servers still answer only that (or hang on a streamable probe) that it is
// worth one fallback attempt rather than telling the user their server is
// dead.
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerRecord } from "../storage/store.js";
import type { ServerSecrets } from "../storage/secrets.js";

export type HttpProtocol = "http" | "sse";

/**
 * Headers this plugin sends on every request to `server`.
 *
 * The bearer and the custom headers are mutually exclusive in the panel, but
 * an `Authorization` typed into the headers list still wins over one derived
 * from a token, because the user wrote it for this server.
 */
export function authHeaders(server: ServerRecord, secrets: ServerSecrets): Record<string, string> {
  const headers: Record<string, string> = { ...secrets.headers };
  const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
  if (secrets.bearer && !hasAuthorization) headers.Authorization = `Bearer ${secrets.bearer}`;
  return headers;
}

function baseUrl(server: ServerRecord): URL {
  if (!server.url) throw new Error(`Server "${server.name}" has no URL`);
  return new URL(server.url);
}

export function createHttpTransport(options: {
  server: ServerRecord;
  protocol: HttpProtocol;
  headers: Record<string, string>;
  authProvider?: OAuthClientProvider;
  fetch?: typeof fetch;
}): Transport {
  const { server, protocol, headers, authProvider, fetch } = options;
  const url = baseUrl(server);
  const requestInit: RequestInit = { headers };

  if (protocol === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      authProvider,
      ...(fetch ? { fetch } : {}),
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    authProvider,
    ...(fetch ? { fetch } : {}),
  });
}

/**
 * A short description of why a streamable attempt failed, used only when the
 * SSE fallback succeeds and the user should still know their server is on the
 * old protocol.
 */
export function describeHttpFailure(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const suffix = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${suffix}`;
  }
  return String(error);
}
