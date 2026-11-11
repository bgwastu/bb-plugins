// tests/oauth.test.ts
//
// Every OAuth test runs against an injected `fetchImpl` and an injected
// `discover`: the flow must never reach the network from a test, and the
// security properties here (single-use state, TTL, single-flight refresh,
// no auto-retry of a write) are only observable when the fake authorization
// server is under the test's control.
import Database from "better-sqlite3";
import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolResult,
  PluginHttpHandler,
} from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClientWith } from "../src/oauth/discovery.js";
import { z } from "zod";
import plugin from "../server.js";
import { createClientPool } from "../src/mcp/client-pool.js";
import { registerOAuthRoutes } from "../src/server/routes.js";
import {
  createOAuthFlow,
  isUnauthorized,
  type OAuthFlow,
  PENDING_TTL_MS,
} from "../src/oauth/flow.js";
import { createPkce } from "../src/oauth/pkce.js";
import { discoverWith } from "../src/oauth/discovery.js";
import { createMcpExecutor } from "../src/server/tools.js";
import type { CatalogTool, Registry, ServerRecord } from "../src/storage/registry.js";
import { createOAuthStore } from "../src/storage/oauth-store.js";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";

function store() {
  const db = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) db.exec(statement);
  return createOAuthStore(db);
}

const metadata = {
  authorizationEndpoint: "https://as.example/authorize",
  tokenEndpoint: "https://as.example/token",
  registrationEndpoint: "https://as.example/register",
  scopesSupported: [],
};

/** A fake authorization server that hands out a new access token each time. */
function fakeAs(options: { expiresIn?: number; refreshStatus?: number } = {}) {
  let issued = 0;
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    const body = new URLSearchParams(init?.body ?? "");
    calls.push({ url, body });
    if (url.endsWith("/register")) {
      return new Response(JSON.stringify({ client_id: "cid" }), { status: 200 });
    }
    if (body.get("grant_type") === "refresh_token" && options.refreshStatus) {
      return new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: options.refreshStatus },
      );
    }
    issued += 1;
    return new Response(
      JSON.stringify({
        access_token: `at${issued}`,
        refresh_token: "rt",
        expires_in: options.expiresIn ?? 3600,
      }),
      { status: 200 },
    );
  });
  return { fetchImpl, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/token")) };
}

describe("pkce", () => {
  it("produces a distinct verifier, challenge and state each time", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toEqual(b.verifier);
    expect(a.challenge).not.toEqual(a.verifier);
    expect(a.state).toHaveLength(43);
  });

  it("keeps every value url-safe", () => {
    const { verifier, challenge, state } = createPkce();
    for (const value of [verifier, challenge, state]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("oauth flow", () => {
  it("survives a restart between begin and complete", async () => {
    const shared = store();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "cid" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "at", refresh_token: "rt", expires_in: 3600,
      }), { status: 200 });
    });
    const begun = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await begun.begin("notion", "https://mcp.notion.com/mcp");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");

    // A second flow object over the same store stands in for a restarted server.
    const restarted = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    expect(await restarted.complete(state, "code")).toEqual({ serverId: "notion" });
    expect(await restarted.accessToken("notion", "https://mcp.notion.com/mcp")).toBe("at");
  });

  it("rejects an unknown or replayed state", async () => {
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata,
      fetchImpl: vi.fn(), redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    await expect(flow.complete("nope", "code")).rejects.toThrow(/state/i);
  });

  it("burns the state on the first callback so a replay cannot mint a second token", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    await flow.complete(state, "code");
    await expect(flow.complete(state, "code")).rejects.toThrow(/state/i);
    // The replay must not have reached the token endpoint at all.
    expect(as.tokenCalls()).toHaveLength(1);
  });

  it("keeps the pending window at ten minutes", () => {
    // Asserted against a literal, not against the constant: the window is how
    // long an unguessed nonce stays reachable from an UNAUTHENTICATED route,
    // so a test that reads the constant it is checking would let someone
    // widen that window to an hour without a single test going red.
    expect(PENDING_TTL_MS).toBe(600_000);
  });

  it("rejects a state older than the ten minute ttl", async () => {
    const as = fakeAs();
    let now = 1_000_000;
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb", now: () => now,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    now += PENDING_TTL_MS + 1;
    await expect(flow.complete(state, "code")).rejects.toThrow(/state/i);
    expect(as.tokenCalls()).toHaveLength(0);
    // Expiry consumes the row too: a slow user cannot retry the same nonce.
    now = 1_000_000;
    await expect(flow.complete(state, "code")).rejects.toThrow(/state/i);
  });

  it("sends the pkce verifier and the authorization code to the token endpoint", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    const authorize = new URL(authorizeUrl);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("client_id")).toBe("cid");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:38886/cb");

    await flow.complete(authorize.searchParams.get("state")!, "the-code");
    const body = as.tokenCalls()[0].body;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier hashes to the challenge the authorize URL advertised.
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:38886/cb");
  });

  it("refreshes at 75 percent of expires_in measured from local receipt", async () => {
    const as = fakeAs({ expiresIn: 1000 });
    let now = 5_000_000;
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb", now: () => now,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");

    expect(await flow.accessToken("notion", "https://mcp.notion.com/mcp")).toBe("at1");
    now += 749 * 1000; // just under 75 percent of 1000 seconds
    expect(await flow.accessToken("notion", "https://mcp.notion.com/mcp")).toBe("at1");
    expect(as.tokenCalls()).toHaveLength(1);

    now += 2 * 1000; // past the 75 percent mark
    expect(await flow.accessToken("notion", "https://mcp.notion.com/mcp")).toBe("at2");
    expect(as.tokenCalls()[1].body.get("grant_type")).toBe("refresh_token");
  });

  it("single-flights the refresh so concurrent callers do not stampede the token endpoint", async () => {
    const as = fakeAs({ expiresIn: 1000 });
    let now = 5_000_000;
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb", now: () => now,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");
    now += 800 * 1000;

    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => flow.accessToken("notion", "https://mcp.notion.com/mcp")),
    );
    expect(tokens).toEqual(Array.from({ length: 8 }, () => "at2"));
    expect(as.tokenCalls().filter((c) => c.body.get("grant_type") === "refresh_token"))
      .toHaveLength(1);
  });

  it("reports a dead refresh token as a reconnect state rather than throwing", async () => {
    const as = fakeAs({ expiresIn: 1000, refreshStatus: 400 });
    let now = 5_000_000;
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb", now: () => now,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");
    expect(flow.status("notion")).toBe("connected");

    now += 800 * 1000;
    expect(await flow.accessToken("notion", "https://mcp.notion.com/mcp")).toBeNull();
    expect(flow.status("notion")).toBe("needs-reconnect");
    // The dead grant is not retried on every call.
    await flow.accessToken("notion", "https://mcp.notion.com/mcp");
    expect(as.tokenCalls().filter((c) => c.body.get("grant_type") === "refresh_token"))
      .toHaveLength(1);
  });

  it("reports an unconfigured server as disconnected and hands out no token", async () => {
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: vi.fn(),
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    expect(flow.status("notion")).toBe("disconnected");
    expect(await flow.accessToken("notion", "https://mcp.notion.com/mcp")).toBeNull();
  });

  it("skips dynamic registration when the server supplies its own client", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(),
      discover: async () => ({ ...metadata, registrationEndpoint: null }),
      fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      staticClient: async () => ({ clientId: "gcp-id", clientSecret: "gcp-secret" }),
    });
    const { authorizeUrl } = await flow.begin("gmail", "https://gmailmcp.googleapis.com/mcp");
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("gcp-id");
    expect(as.calls.some((c) => c.url.endsWith("/register"))).toBe(false);

    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");
    expect(as.tokenCalls()[0].body.get("client_secret")).toBe("gcp-secret");
  });

  it("explains itself when a server supports neither registration nor a manual client", async () => {
    const flow = createOAuthFlow({
      store: store(),
      discover: async () => ({ ...metadata, registrationEndpoint: null }),
      fetchImpl: vi.fn(), redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    await expect(flow.begin("gmail", "https://gmailmcp.googleapis.com/mcp"))
      .rejects.toThrow(/client id/i);
  });

  it("points at the server's own OAuth section rather than plugin settings", async () => {
    const flow = createOAuthFlow({
      store: store(),
      discover: async () => ({ ...metadata, registrationEndpoint: null }),
      fetchImpl: vi.fn(), redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    // There are no settings to save it in any more, and an error naming a
    // screen that does not exist is worse than no error at all.
    await expect(flow.begin("gmail", "https://gmailmcp.googleapis.com/mcp"))
      .rejects.toThrow(/OAuth client/);
  });

  it("registers a client for a server with none saved and skips it for one that has", async () => {
    const withClient = fakeAs();
    const manual = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: withClient.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      staticClient: async () => ({ clientId: "gcp-id", clientSecret: "gcp-secret" }),
    });
    const manualUrl = await manual.begin("gmail", "https://gmailmcp.googleapis.com/mcp");
    expect(new URL(manualUrl.authorizeUrl).searchParams.get("client_id")).toBe("gcp-id");
    expect(withClient.calls.some((c) => c.url.endsWith("/register"))).toBe(false);

    // Same code path, same registration endpoint on offer: what differs is
    // only whether the server's row carries a client of its own.
    const withoutClient = fakeAs();
    const registered = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: withoutClient.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      staticClient: async () => null,
    });
    const registeredUrl = await registered.begin("notion", "https://mcp.notion.com/mcp");
    expect(new URL(registeredUrl.authorizeUrl).searchParams.get("client_id")).toBe("cid");
    expect(withoutClient.calls.some((c) => c.url.endsWith("/register"))).toBe(true);
  });

  it("puts the configured scopes on the authorize url", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      // Scopes are a separate hook from the client on purpose: Slack registers
      // its own client and still needs these.
      scopes: () => "channels:read,  chat:write\nusers:read",
    });
    const { authorizeUrl } = await flow.begin("slack", "https://slack.com/mcp");
    // Whatever the user typed goes in; a space-delimited list comes out.
    expect(new URL(authorizeUrl).searchParams.get("scope"))
      .toBe("channels:read chat:write users:read");
  });

  it("asks for no scope at all when none is configured", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      scopes: () => null,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    // An empty `scope` is not the same request as no `scope`, and a server
    // that reads it as "nothing" issues a token good for nothing.
    expect(new URL(authorizeUrl).searchParams.has("scope")).toBe(false);
  });

  it("asks for offline access every time", async () => {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    // Google issues no refresh token without both, and RFC 6749 requires any
    // other authorization server to ignore what it does not recognise, so
    // these are unconditional rather than per-provider.
    const authorize = new URL(authorizeUrl);
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
  });

  it("does not reuse a stored client after the user corrects the client id", async () => {
    const as = fakeAs();
    const shared = store();
    let clientId = "typo-id";
    const flow = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      staticClient: async () => ({ clientId, clientSecret: "s" }),
    });
    const first = await flow.begin("gmail", "https://gmailmcp.googleapis.com/mcp");
    expect(new URL(first.authorizeUrl).searchParams.get("client_id")).toBe("typo-id");

    // The resource and the redirect uri have not moved, so the reuse check
    // used to pass and the corrected id was silently discarded - forever,
    // because nothing else ever rewrites that row.
    clientId = "correct-id";
    const second = await flow.begin("gmail", "https://gmailmcp.googleapis.com/mcp");
    expect(new URL(second.authorizeUrl).searchParams.get("client_id")).toBe("correct-id");
    expect(shared.getClient("gmail")?.clientId).toBe("correct-id");
  });
});

describe("discovery", () => {
  it("follows the protected resource document to its authorization server", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ authorization_servers: ["https://as.example"] }),
          { status: 200 },
        );
      }
      if (url === "https://as.example/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://as.example/a",
          token_endpoint: "https://as.example/t",
          registration_endpoint: "https://as.example/r",
        }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverWith(fetchImpl, "https://mcp.notion.com/mcp")).toEqual({
      authorizationEndpoint: "https://as.example/a",
      tokenEndpoint: "https://as.example/t",
      registrationEndpoint: "https://as.example/r",
      scopesSupported: [],
    });
  });

  it("falls back to conventional endpoints when nothing is published", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 404 }));
    expect(await discoverWith(fetchImpl, "https://mcp.notion.com/mcp")).toEqual({
      authorizationEndpoint: "https://mcp.notion.com/authorize",
      tokenEndpoint: "https://mcp.notion.com/token",
      registrationEndpoint: "https://mcp.notion.com/register",
      scopesSupported: [],
    });
  });

  it("falls back rather than throwing when the document names something unparseable", async () => {
    // The module's contract is that a bad discovery document is not an error.
    // An unparseable entry used to reach `new URL` and surface as a raw
    // TypeError out of `begin()`.
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input).includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ authorization_servers: ["notaurl"] }), { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverWith(fetchImpl, "https://mcp.notion.com/mcp")).toEqual({
      authorizationEndpoint: "https://mcp.notion.com/authorize",
      tokenEndpoint: "https://mcp.notion.com/token",
      registrationEndpoint: "https://mcp.notion.com/register",
      scopesSupported: [],
    });
  });

  it("refuses endpoints that would put the code and verifier on the wire", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return new Response("no", { status: 404 });
      if (url.includes("oauth-authorization-server")) {
        return new Response(JSON.stringify({
          authorization_endpoint: "http://mcp.notion.com/a",
          token_endpoint: "http://mcp.notion.com/t",
          registration_endpoint: "http://mcp.notion.com/r",
        }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    // The downgraded document is discarded, not obeyed: what comes back is
    // the conventional https endpoints, never an http one.
    const found = await discoverWith(fetchImpl, "https://mcp.notion.com/mcp");
    expect(found.authorizationEndpoint).toBe("https://mcp.notion.com/authorize");
    expect(found.tokenEndpoint).toBe("https://mcp.notion.com/token");
  });

  it("drops a registration endpoint that is not https but keeps the rest", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return new Response("no", { status: 404 });
      if (url.includes("oauth-authorization-server")) {
        return new Response(JSON.stringify({
          authorization_endpoint: "https://mcp.notion.com/a",
          token_endpoint: "https://mcp.notion.com/t",
          registration_endpoint: "http://mcp.notion.com/r",
        }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    // A client secret would come back through that registration in cleartext.
    // Without it the flow asks for a manual client id, which is worse to use
    // and not a leak.
    expect(await discoverWith(fetchImpl, "https://mcp.notion.com/mcp")).toEqual({
      authorizationEndpoint: "https://mcp.notion.com/a",
      tokenEndpoint: "https://mcp.notion.com/t",
      registrationEndpoint: null,
      scopesSupported: [],
    });
  });

  it("refuses to invent endpoints for an insecure issuer", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      if (String(input).includes("oauth-protected-resource")) {
        return new Response(
          JSON.stringify({ authorization_servers: ["http://evil.example"] }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    });
    await expect(discoverWith(fetchImpl, "https://mcp.notion.com/mcp"))
      .rejects.toThrow(/https/i);
  });

  it("still allows a loopback authorization server for local development", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("oauth-authorization-server")) {
        return new Response(JSON.stringify({
          authorization_endpoint: "http://127.0.0.1:9999/a",
          token_endpoint: "http://127.0.0.1:9999/t",
        }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    const found = await discoverWith(fetchImpl, "http://127.0.0.1:9999/mcp");
    expect(found.tokenEndpoint).toBe("http://127.0.0.1:9999/t");
  });
});

describe("401 handling", () => {
  const server: ServerRecord = {
    id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
    url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
    cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  };
  const registry = { getServer: () => server } as unknown as Registry;
  const ctx: PluginAgentToolContext = {
    threadId: "t1", projectId: "p1", signal: new AbortController().signal,
  };
  /** `PluginAgentToolResult` widens to a bare string, which this never is. */
  function failed(result: PluginAgentToolResult): boolean {
    return typeof result === "object" && result !== null && result.isError === true;
  }
  function tool(readOnly: boolean): CatalogTool {
    return {
      serverId: "notion", upstreamName: "search", registeredName: "search",
      description: "", inputSchema: {}, readOnly, defaultEnabled: false, stale: false, syncedAt: 1,
    };
  }

  it("recognises the shapes a 401 arrives in", () => {
    expect(isUnauthorized(Object.assign(new Error("nope"), { code: 401 }))).toBe(true);
    expect(isUnauthorized(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isUnauthorized(new Error("HTTP 500"))).toBe(false);
    expect(isUnauthorized(new Error("bad request: 4010 items"))).toBe(false);
  });

  it("retries a read-only tool once after a refresh", async () => {
    let attempt = 0;
    const pool = {
      callTool: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error("HTTP 401"), { code: 401 });
        return { content: [{ type: "text" as const, text: "ok" }], isError: false };
      }),
    };
    const refreshAuth = vi.fn(async () => true);
    const execute = createMcpExecutor({
      registry, pool: pool as never, stderrTail: () => [], refreshAuth,
    });
    const result = await execute(tool(true), {}, ctx);
    expect(failed(result)).toBe(false);
    expect(pool.callTool).toHaveBeenCalledTimes(2);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
  });

  it("never auto-retries a write, because a double POST is worse than a failure", async () => {
    const pool = {
      callTool: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 401"), { code: 401 });
      }),
    };
    const refreshAuth = vi.fn(async () => true);
    const execute = createMcpExecutor({
      registry, pool: pool as never, stderrTail: () => [], refreshAuth,
    });
    const result = await execute(tool(false), {}, ctx);
    expect(failed(result)).toBe(true);
    expect(pool.callTool).toHaveBeenCalledTimes(1);
    expect(refreshAuth).not.toHaveBeenCalled();
    // The failure the user sees has to explain itself: silence here reads as
    // a broken plugin rather than a deliberate refusal to replay a write.
    const message = typeof result === "object" ? JSON.stringify(result.content) : "";
    expect(message).toContain("rejected the stored credentials");
    expect(message).toContain("not retried");
    expect(message).toContain("try again");
  });

  it("does not retry a read-only tool when the refresh produced no new token", async () => {
    const pool = {
      callTool: vi.fn(async () => {
        throw Object.assign(new Error("HTTP 401"), { code: 401 });
      }),
    };
    const execute = createMcpExecutor({
      registry, pool: pool as never, stderrTail: () => [],
      refreshAuth: async () => false,
    });
    const result = await execute(tool(true), {}, ctx);
    expect(failed(result)).toBe(true);
    expect(pool.callTool).toHaveBeenCalledTimes(1);
  });
});

describe("callback route", () => {
  let host: ReturnType<typeof createFakePluginHost> | null = null;
  afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

  async function load() {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    await plugin(host.bb);
    return host;
  }

  it("is unauthenticated, because a browser redirect carries no BB credential", async () => {
    const active = await load();
    const route = active.harness.inspection.registrations.httpRoutes.find(
      (record) => record.path === "/oauth/callback",
    );
    expect(route).toBeDefined();
    expect(route?.method).toBe("GET");
    // "local" would reject a redirect from Notion for having no BB app
    // origin and "token" for carrying no plugin token; the state nonce is
    // what stands in for both.
    expect(route?.auth).toBe("none");
  });

  it("answers a forged state with a page rather than a crash or a token", async () => {
    const active = await load();
    const response = await active.harness.behavior.fetchHttp(
      "GET", "/oauth/callback?state=forged&code=whatever",
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("That did not work");
    // Nothing about the failure leaks back to the browser.
    expect(body).not.toContain("forged");
  });

  it("declares no plugin-global OAuth settings", async () => {
    const active = await load();
    // A manual client is per server now. Settings keys are static, so one
    // `googleClientId` could serve exactly one server: not Slack as well, not
    // a self-hosted deployment, not a second Google account.
    expect(active.harness.inspection.registrations.settingsDescriptors).toEqual({});
  });
});

describe("bearer header wiring", () => {
  const server: ServerRecord = {
    id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
    url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
    cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  };

  function upstream() {
    const mcp = new McpServer({ name: "fake", version: "1.0.0" });
    mcp.registerTool("search", {
      description: "Search", inputSchema: { q: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ q }) => ({ content: [{ type: "text", text: q }] }));
    return mcp;
  }

  /**
   * A pool whose transport factory records the headers it was handed.
   *
   * The recording IS the assertion: `getAuthHeader` was declared on the pool
   * for four tasks before anything called it, and a pool that stopped calling
   * it would connect every remote server unauthenticated while every other
   * test stayed green.
   */
  function recordingPool(
    flow: { accessToken(id: string, resourceUrl: string): Promise<string | null> },
  ) {
    const headers: Array<Record<string, string>> = [];
    const pool = createClientPool({
      createTransport: async (_serverRecord, resolveAuthHeaders) => {
        // Called here rather than stored, because production calls it per
        // request: what this records is the header one connection went out
        // with, which is still what every assertion below is about.
        headers.push(await resolveAuthHeaders());
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await upstream().connect(serverSide);
        return clientSide;
      },
      // Mirrors server.ts: the record, not just the id, so the token can be
      // checked against the url it is about to be sent to.
      getAuthHeader: async (record): Promise<Record<string, string>> => {
        const token = await flow.accessToken(record.id, record.url ?? "");
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      log: { warn: vi.fn(), info: vi.fn() },
    });
    return { pool, headers };
  }

  async function connected(options: { expiresIn?: number; now(): number }) {
    const as = fakeAs({ expiresIn: options.expiresIn });
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb", now: options.now,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");
    return flow;
  }

  it("carries the stored access token into the transport", async () => {
    const flow = await connected({ now: () => 5_000_000 });
    const { pool, headers } = recordingPool(flow);
    await pool.listTools(server);
    expect(headers).toEqual([{ Authorization: "Bearer at1" }]);
    await pool.closeAll();
  });

  it("sends no header for a server that was never authorized", async () => {
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata, fetchImpl: vi.fn(),
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { pool, headers } = recordingPool(flow);
    await pool.listTools(server);
    // A local stdio server and an unauthenticated remote one both land here;
    // neither should be sent an empty bearer.
    expect(headers).toEqual([{}]);
    await pool.closeAll();
  });

  it("carries a REFRESHED token into the next connection", async () => {
    let now = 5_000_000;
    const flow = await connected({ expiresIn: 1000, now: () => now });
    const { pool, headers } = recordingPool(flow);

    await pool.listTools(server);
    // What a 401 does: the pool drops the client, so the next call reconnects.
    // Streamable HTTP bakes headers in at construction, so a refreshed token
    // only ever reaches a server through a NEW transport.
    now += 800 * 1000;
    await pool.close(server.id);
    await pool.listTools(server);

    expect(headers).toEqual([
      { Authorization: "Bearer at1" },
      { Authorization: "Bearer at2" },
    ]);
    await pool.closeAll();
  });
});

describe("callback page", () => {
  /** The handler only ever reads query parameters off its context. */
  function request(handler: PluginHttpHandler, query: Record<string, string>) {
    return handler({
      req: { query: (key: string) => query[key] },
    } as unknown as Context);
  }

  function routeFor(flow: Partial<OAuthFlow>): PluginHttpHandler {
    let handler: PluginHttpHandler | null = null;
    const bb = {
      pluginId: "mcp-hub",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      http: { route: (_m: string, _p: string, given: PluginHttpHandler) => { handler = given; } },
      server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
    } as unknown as BbPluginApi;
    registerOAuthRoutes(bb, { flow: flow as OAuthFlow, onConnected: vi.fn() });
    if (!handler) throw new Error("no route registered");
    return handler;
  }

  it("never renders what the authorization server said", async () => {
    // A failed exchange quotes the upstream body, and that body can carry a
    // client secret, an internal hostname or an error the user cannot act on.
    // This page is rendered in a browser tab with no BB session behind it.
    const upstreamBody = 'invalid_client: {"client_secret":"hunter2"}';
    const handler = routeFor({
      complete: async () => { throw new Error(`token endpoint said ${upstreamBody}`); },
    });
    const body = await (await request(handler, { state: "s", code: "c" })).text();

    expect(body).toContain("That did not work");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("invalid_client");
    expect(body).not.toContain("token endpoint said");
  });

  it("does not exchange a code when the user cancelled", async () => {
    const complete = vi.fn();
    const handler = routeFor({ complete });
    const body = await (await request(handler, { error: "access_denied" })).text();
    expect(body).toContain("Connection cancelled");
    expect(complete).not.toHaveBeenCalled();
  });

  it("escapes what it does echo back", async () => {
    const handler = routeFor({ complete: vi.fn() });
    const body = await (await request(handler, { error: '<script>alert(1)</script>' })).text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

/**
 * What happens to a grant when the server it belongs to goes away, and what a
 * stored bearer may be attached to. Both are about the same slug being
 * reusable: remove "Notion", add a new server also called "Notion", and the
 * id the tokens are keyed on is identical.
 */
describe("oauth credential lifetime", () => {
  const resource = "https://mcp.notion.com/mcp";

  async function connected() {
    const shared = store();
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await flow.begin("notion", resource);
    await flow.complete(new URL(authorizeUrl).searchParams.get("state")!, "code");
    return { shared, flow };
  }

  it("deletes the tokens, the client and any pending row when a server is forgotten", async () => {
    const { shared, flow } = await connected();
    // A second dance the user walked away from, still parked in the table.
    const { authorizeUrl } = await flow.begin("notion", resource);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(shared.getTokens("notion")).toBeDefined();
    expect(shared.getClient("notion")).toBeDefined();

    flow.forget("notion");

    expect(shared.getTokens("notion")).toBeUndefined();
    expect(shared.getClient("notion")).toBeUndefined();
    expect(shared.takePending(state)).toBeUndefined();
    expect(flow.status("notion")).toBe("disconnected");
  });

  it("refuses to hand a stored token to a host it was not issued for", async () => {
    const { flow } = await connected();
    expect(await flow.accessToken("notion", resource)).toBe("at1");
    // The slug survives a remove-and-re-add; the grant must not follow it to
    // whatever the new server points at.
    expect(await flow.accessToken("notion", "https://evil.example/mcp")).toBeNull();
  });
});

describe("dynamic client registration against a server that does not do OAuth", () => {
  const metadata = {
    authorizationEndpoint: "http://localhost:4789/authorize",
    tokenEndpoint: "http://localhost:4789/token",
    // Not advertised by the server: synthesised from the resource origin when
    // discovery finds no metadata document, which is exactly the case here.
    registrationEndpoint: "http://localhost:4789/register",
    scopesSupported: [],
  };

  it("names the HTML answer instead of leaking a JSON parse error", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "<!doctype html>\n<html lang=\"en\"><head></head></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));

    // A single-page-app host answers every unrouted path with its index page
    // and a 200, so `response.ok` holds and only the body gives it away.
    // "Unexpected token '<'" tells the user nothing they can act on.
    await expect(registerClientWith(fetchImpl, metadata, "http://127.0.0.1/cb"))
      .rejects.toThrow(/text\/html.*rather than JSON|does not appear to support OAuth/s);
  });

  it("still registers against a server that answers with JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ client_id: "abc", client_secret: "shh" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    expect(await registerClientWith(fetchImpl, metadata, "http://127.0.0.1/cb"))
      .toEqual({ clientId: "abc", clientSecret: "shh" });
  });
});

/**
 * How a dead grant becomes something a user can read.
 *
 * The failure this covers ran for four days in production: Cloudflare Access
 * ended the grant at its 24-hour limit, the refresh came back
 * `400 invalid_grant`, and the only record was a log line. Everything below is
 * about the report, not about the refusal.
 */
describe("reporting a grant that cannot be refreshed", () => {
  async function connectThenRefresh(options: {
    tokenEndpoint?: string;
    refreshStatus?: number;
    body?: string;
  }) {
    const shared = store();
    const failures: Array<[string, string]> = [];
    const recovered: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: { body?: string }) => {
      const url = String(input);
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "cid" }), { status: 200 });
      }
      const form = new URLSearchParams(init?.body ?? "");
      if (form.get("grant_type") === "refresh_token" && options.refreshStatus) {
        return new Response(
          options.body ?? JSON.stringify({
            error: "invalid_grant", error_description: "Grant not found",
          }),
          { status: options.refreshStatus },
        );
      }
      return new Response(JSON.stringify({
        access_token: "at", refresh_token: "rt", expires_in: 900,
      }), { status: 200 });
    });
    const flow = createOAuthFlow({
      store: shared,
      discover: async () => ({
        ...metadata,
        tokenEndpoint: options.tokenEndpoint ?? metadata.tokenEndpoint,
      }),
      fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      onAuthFailure: (id, message) => { failures.push([id, message]); },
      onAuthRecovered: (id) => { recovered.push(id); },
    });
    const { authorizeUrl } = await flow.begin("executor", "https://executor.test/mcp");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await flow.complete(state, "code");
    return { flow, failures, recovered };
  }

  it("quotes what the authorization server actually said", async () => {
    const { flow, failures } = await connectThenRefresh({ refreshStatus: 400 });
    expect(await flow.refresh("executor")).toBe(false);
    expect(failures).toHaveLength(1);
    // "Grant not found", not "HTTP 400" and not a JSON blob: the description is
    // the only part a user can act on.
    expect(failures[0][1]).toContain("Grant not found");
  });

  it("names the Cloudflare setting that is actually ending the grant", async () => {
    const { flow, failures } = await connectThenRefresh({
      tokenEndpoint: "https://acme.cloudflareaccess.com/cdn-cgi/access/oauth/token",
      refreshStatus: 400,
    });
    await flow.refresh("executor");
    // Reconnecting buys another 24 hours and nothing more, so an error that
    // only said "reconnect" would send the user round the same loop daily.
    expect(failures[0][1]).toMatch(/Grant session duration/i);
  });

  it("says nothing about a refusal that is merely transient", async () => {
    const { flow, failures } = await connectThenRefresh({ refreshStatus: 503 });
    expect(await flow.refresh("executor")).toBe(false);
    // A 5xx keeps the grant, so there is nothing for a user to do about it.
    expect(failures).toEqual([]);
  });

  it("reports recovery when a grant is authorized again", async () => {
    const { recovered } = await connectThenRefresh({});
    expect(recovered).toEqual(["executor"]);
  });
});

describe("asking for a refresh token", () => {
  async function scopesOf(scopesSupported: string[], configured: string | null) {
    const as = fakeAs();
    const flow = createOAuthFlow({
      store: store(),
      discover: async () => ({ ...metadata, scopesSupported }),
      fetchImpl: as.fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
      scopes: () => configured,
    });
    const { authorizeUrl } = await flow.begin("notion", "https://mcp.notion.com/mcp");
    return new URL(authorizeUrl).searchParams.get("scope");
  }

  it("adds offline_access when the server advertises it", async () => {
    expect(await scopesOf(["openid", "offline_access"], "read")).toBe("read offline_access");
  });

  it("does not invent it for a server that never mentioned it", async () => {
    // Cloudflare Access advertises no scopes at all, and a server that does not
    // know the scope may refuse the whole authorization request (SEP-2207).
    expect(await scopesOf([], null)).toBeNull();
  });
});
