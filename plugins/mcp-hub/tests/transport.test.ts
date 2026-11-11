import { afterEach, describe, expect, it } from "vitest";
import {
  createHttpTransport,
  describeTransportFailure,
  mergeHeaders,
} from "../src/mcp/transport.js";
import { isUnauthorized } from "../src/oauth/flow.js";
import type { ServerRecord } from "../src/storage/registry.js";

const server: ServerRecord = {
  id: "vl", displayName: "VL", transport: "http", kind: "remote" as const, url: "https://vl/mcp",
  command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
  oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
  authError: null, authErrorAt: null,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("http request headers", () => {
  it("sends the server's own headers when there is no grant", () => {
    expect(mergeHeaders({ ...server, headers: { "X-Api-Key": "k" } }, {}))
      .toEqual({ "X-Api-Key": "k" });
  });

  it("lets the OAuth bearer win over a typed-in Authorization", () => {
    // The stored token is the one this plugin refreshes; the typed one was
    // true when it was typed.
    expect(mergeHeaders(
      { ...server, headers: { Authorization: "Bearer typed", "X-Tenant": "acme" } },
      { Authorization: "Bearer minted" },
    )).toEqual({ Authorization: "Bearer minted", "X-Tenant": "acme" });
  });
});

/** What the SDK throws for a failed POST: the status is on `code`, not in the text. */
function streamableError(status: number, body: string): Error {
  return Object.assign(
    new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
    { code: status },
  );
}

describe("describing a transport failure", () => {
  it("names the status and the missing path when a root URL answers 405", () => {
    const rooted = { ...server, url: "https://vl/", displayName: "VL" };
    const described = describeTransportFailure(rooted, streamableError(405, ""));
    expect(String(described)).toContain("HTTP 405");
    expect(String(described)).toContain("/mcp");
  });

  it("keeps a 401 recognisable so the token is still refreshed", () => {
    const described = describeTransportFailure(server, streamableError(401, "expired"));
    expect(isUnauthorized(described)).toBe(true);
    expect(String(described)).toContain("expired");
  });

  it("leaves alone a failure that carries no HTTP status", () => {
    const local = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(describeTransportFailure({ ...server, transport: "stdio" }, local)).toBe(local);
    expect(describeTransportFailure(server, local)).toBe(local);
  });
});

describe("a live http connection's credentials", () => {
  it("resolves the auth header per request, not once per connection", async () => {
    // The bug this exists for: a pooled client outlives its access token, and
    // `requestInit.headers` is read from an object fixed at construction - so
    // a connection opened an hour ago goes on presenting an expired bearer
    // with no way to correct it from outside.
    let minted = 0;
    const transport = createHttpTransport(
      { ...server, headers: { "X-Tenant": "acme" } },
      async () => {
        minted += 1;
        return { Authorization: `Bearer token-${minted}` };
      },
    );
    const seen: string[] = [];
    const tenants: Array<string | null> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("Authorization") ?? "");
      tenants.push(headers.get("X-Tenant"));
      return new Response("", { status: 202 });
    }) as typeof fetch;

    await transport.send({ jsonrpc: "2.0", method: "ping", id: 1 });
    await transport.send({ jsonrpc: "2.0", method: "ping", id: 2 });

    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"]);
    // The server's own static headers still ride along on every request.
    expect(tenants).toEqual(["acme", "acme"]);
  });
});
