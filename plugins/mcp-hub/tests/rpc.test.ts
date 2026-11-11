import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { rpcContract } from "../contract.js";
import plugin from "../server.js";
import { registerRpc, type RpcDeps } from "../src/server/rpc.js";
import { createOAuthStore } from "../src/storage/oauth-store.js";
import { createRegistry, type ServerRecord } from "../src/storage/registry.js";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

async function load(): Promise<ReturnType<typeof createFakePluginHost>> {
  host = createFakePluginHost({ pluginId: "mcp-hub" });
  await plugin(host.bb);
  return host;
}

type Method = keyof typeof rpcContract & string;
type Output<M extends Method> = z.infer<(typeof rpcContract)[M]["output"]>;

/** The fake host validates against the contract but returns `unknown`. */
function call<M extends Method>(
  active: ReturnType<typeof createFakePluginHost>,
  method: M,
  input: unknown,
): Promise<Output<M>> {
  return active.harness.behavior.callRpc(method, input) as Promise<Output<M>>;
}

function addEcho(
  active: ReturnType<typeof createFakePluginHost>,
): Promise<Output<"servers_add">> {
  return call(active, "servers_add", {
    displayName: "Echo", kind: "local" as const,
    command: process.execPath, args: [fixture],
  });
}

function addRemote(
  active: ReturnType<typeof createFakePluginHost>,
  displayName: string,
  url: string,
): Promise<Output<"servers_add">> {
  return call(active, "servers_add", { displayName, kind: "remote" as const, url });
}

describe("rpc", () => {
  it("adds, lists and removes a server", async () => {
    const active = await load();
    const added = await addEcho(active);
    expect(added.server.id).toBe("echo");
    expect((await call(active, "servers_list", null)).servers).toHaveLength(1);
    expect(await call(active, "servers_remove", { id: "echo" })).toEqual({ removed: true });
    expect((await call(active, "servers_list", null)).servers).toEqual([]);
  });

  it("derives the slug id from the display name", async () => {
    const active = await load();
    const added = await call(active, "servers_add", {
      displayName: "Chrome DevTools (beta)", kind: "remote" as const,
      url: "https://example.test/mcp",
    });
    expect(added.server.id).toBe("chrome-devtools-beta");
  });

  it("refuses a second server with the same derived id", async () => {
    const active = await load();
    await addEcho(active);
    await expect(addEcho(active)).rejects.toThrow(/already/i);
  });

  it("refuses a stdio server with no command", async () => {
    const active = await load();
    await expect(call(active, "servers_add", {
      displayName: "Broken", kind: "local" as const,
    })).rejects.toThrow();
  });

  it("syncs a catalog and lists what it found", async () => {
    const active = await load();
    await addEcho(active);
    expect(await call(active, "catalog_sync", { serverId: "echo" }))
      .toEqual({ added: ["echo"], total: 1 });
    const { tools } = await call(active, "tools_list", {});
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      serverId: "echo", upstreamName: "echo", registeredName: "echo",
      readOnly: false, stale: false,
    });
    expect(tools[0].schemaBytes).toBeGreaterThan(0);
    expect(tools[0].estimatedTokens).toBeGreaterThan(0);
  });

  it("adds nothing on a repeated sync", async () => {
    const active = await load();
    await addEcho(active);
    await call(active, "catalog_sync", { serverId: "echo" });
    expect(await call(active, "catalog_sync", { serverId: "echo" }))
      .toEqual({ added: [], total: 1 });
  });

  it("refuses to sync an unknown server", async () => {
    const active = await load();
    await expect(call(active, "catalog_sync", { serverId: "nope" }))
      .rejects.toThrow(/nope/);
  });

  it("hands back one tool's whole description and parameters", async () => {
    const active = await load();
    await addEcho(active);
    await call(active, "catalog_sync", { serverId: "echo" });
    const { tool } = await call(active, "tool_details", { registeredName: "echo" });
    expect(tool.description).toBe("Echo text");
    expect(tool.parameters).toEqual([
      { name: "text", type: "string", required: true, description: null },
    ]);
    expect(JSON.parse(tool.inputSchema)).toMatchObject({ type: "object" });
  });

  it("refuses details for an unknown tool", async () => {
    const active = await load();
    await expect(call(active, "tool_details", { registeredName: "nope" }))
      .rejects.toThrow(/nope/);
  });

  it("counts only the tools it knows when setting defaults", async () => {
    const active = await load();
    await addEcho(active);
    await call(active, "catalog_sync", { serverId: "echo" });
    // An unknown name is skipped rather than refused, for the same reason
    // `binding_set` tolerates one: the panel may be a sync behind.
    const result = await call(active, "tools_set_default", {
      registeredNames: ["echo", "never-synced"], defaultEnabled: true,
    });
    expect(result).toEqual({ updated: 1 });
    const { tools } = await call(active, "tools_list", { serverId: "echo" });
    expect(tools[0].defaultEnabled).toBe(true);
  });

  it("round-trips a project's three override states", async () => {
    const active = await load();
    await addEcho(active);
    await call(active, "catalog_sync", { serverId: "echo" });
    await call(active, "binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "on",
    });
    expect((await call(active, "bindings_list", { projectId: "proj_a" })).overrides)
      .toEqual([{ registeredName: "echo", enabled: true }]);
    // Force-off is a row of its own, not the absence of one: a listing that
    // dropped it could not tell it from a project that never chose.
    await call(active, "binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "off",
    });
    expect((await call(active, "bindings_list", { projectId: "proj_a" })).overrides)
      .toEqual([{ registeredName: "echo", enabled: false }]);
    await call(active, "binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "inherit",
    });
    expect((await call(active, "bindings_list", { projectId: "proj_a" })).overrides)
      .toEqual([]);
  });
});

describe("rpc servers_test", () => {
  it("reports a failing stdio server with its stderr tail", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Broken", kind: "local" as const,
      command: process.execPath, args: [path.join(path.dirname(fixture), "does-not-exist.mjs")],
    });
    const result = await call(active, "servers_test", { id: "broken" });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    // The whole point of the feature: without this the user sees only the
    // MCP SDK's "Connection closed".
    expect(result.stderr.join("\n")).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });

  it("reports a working stdio server and how many tools it has", async () => {
    const active = await load();
    await addEcho(active);
    expect(await call(active, "servers_test", { id: "echo" }))
      .toMatchObject({ ok: true, toolCount: 1, error: null });
  });

  it("refuses to test an unknown server", async () => {
    const active = await load();
    await expect(call(active, "servers_test", { id: "nope" })).rejects.toThrow(/nope/);
  });
});

describe("rpc projects_list", () => {
  it("lists projects and flags the personal one", async () => {
    host = createFakePluginHost({
      pluginId: "mcp-hub",
      sdk: {
        projects: {
          list: () => [
            { id: "proj_personal", name: "Personal", kind: "personal" },
            { id: "proj_work", name: "Work", kind: "standard" },
          ],
        },
      },
    });
    await plugin(host.bb);
    expect((await call(host, "projects_list", null)).projects).toEqual([
      { id: "proj_personal", name: "Personal", personal: true },
      { id: "proj_work", name: "Work", personal: false },
    ]);
    // Personal threads all share one project id, so omitting it would hide
    // the busiest project in the list.
    expect(host.harness.sdk.callsTo("projects.list").at(-1))
      .toEqual([{ includePersonal: true }]);
  });
});

/**
 * `servers_connect` is tested against `registerRpc` directly rather than the
 * whole plugin: the real flow's `begin` performs OAuth discovery over the
 * network, and no test may reach the network (see tests/oauth.test.ts, which
 * owns the flow itself). What is worth pinning here is the mapping - which
 * transport is allowed to start a dance, and that the URL comes back
 * untouched.
 */
describe("rpc servers_connect", () => {
  function deps(servers: ServerRecord[], begin: RpcDeps["oauth"]["begin"]): RpcDeps {
    const handle = new Database(":memory:");
    for (const statement of MCP_MIGRATIONS) handle.exec(statement);
    const registry = createRegistry(handle);
    for (const server of servers) registry.upsertServer(server);
    return {
      registry,
      catalog: { sync: async () => [], syncAll: async () => {} },
      pool: { listTools: async () => [] },
      oauth: {
        begin,
        complete: async () => ({ serverId: "echo" }),
        status: () => "disconnected" as const,
        forget: () => {},
        registeredRedirectUri: () => null,
      },
      onAuthChanged: () => {},
      stderrTail: () => [],
      onCatalogChanged: () => {},
      onSelectionChanged: () => {},
      dropClient: async () => {},
    };
  }

  const remote: ServerRecord = {
    id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
    url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
    cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  };

  it("returns the authorize url for an http server", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const seen: Array<[string, string, string | undefined]> = [];
    registerRpc(host.bb, deps([remote], async (id, url, origin) => {
      seen.push([id, url, origin]);
      return { authorizeUrl: "https://auth.example/authorize?state=abc" };
    }));
    expect(await call(host, "servers_connect", {
      id: "notion", redirectOrigin: "https://bb.example.ts.net",
    })).toEqual({ authorizeUrl: "https://auth.example/authorize?state=abc" });
    // The origin comes from the panel and has to reach the flow intact: it is
    // the whole of what stops the callback being aimed at 127.0.0.1, which is
    // nowhere at all for a browser on another machine.
    expect(seen).toEqual([
      ["notion", "https://mcp.notion.com/mcp", "https://bb.example.ts.net"],
    ]);
  });

  it("connects a server that needs no sign-in without starting OAuth", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const synced: string[] = [];
    const base = deps([remote], async () => { throw new Error("must not be called"); });
    registerRpc(host.bb, {
      ...base,
      pool: { listTools: async () => [{ name: "search", description: "", inputSchema: {}, readOnly: true }] as never },
      catalog: { sync: async (id: string) => { synced.push(id); return []; }, syncAll: async () => {} },
    });
    expect(await call(host, "servers_connect", { id: "notion", redirectOrigin: "https://bb.example" }))
      .toEqual({ authorizeUrl: null });
    expect(synced).toEqual(["notion"]);
  });

  it("starts OAuth when the server refuses an unauthenticated tools list", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const base = deps([remote], async () => ({ authorizeUrl: "https://auth.example/authorize" }));
    registerRpc(host.bb, {
      ...base,
      pool: { listTools: async () => { throw new Error("401 Unauthorized"); } },
    });
    expect(await call(host, "servers_connect", { id: "notion", redirectOrigin: "https://bb.example" }))
      .toEqual({ authorizeUrl: "https://auth.example/authorize" });
  });

  it("refuses a server whose Authorization header already authenticates it", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    registerRpc(host.bb, deps([{
      ...remote, id: "executor", url: "http://localhost:4789/mcp",
      headers: { Authorization: "Bearer static-token" },
    }], async () => { throw new Error("must not be called"); }));
    // Discovery falls back to conventional endpoints on the resource's own
    // origin, so a single-page-app host answers `/register` with HTML and a
    // 200. The user gets a JSON parse error about a server they never said
    // spoke OAuth.
    await expect(call(host, "servers_connect", { id: "executor", redirectOrigin: "https://bb.example" }))
      .rejects.toThrow(/Authorization header/i);
  });

  it("still connects a server that sets a header and asked for OAuth", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    registerRpc(host.bb, deps([{
      ...remote, headers: { Authorization: "Bearer stale" }, oauthClientId: "client-1",
    }], async () => ({ authorizeUrl: "https://auth.example/authorize" })));
    // A configured OAuth client is the user saying so outright; the header is
    // whatever was true before they did.
    expect(await call(host, "servers_connect", { id: "notion", redirectOrigin: "https://bb.example" }))
      .toEqual({ authorizeUrl: "https://auth.example/authorize" });
  });

  it("refuses a stdio server, which has no OAuth to begin", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    registerRpc(host.bb, deps([{
      ...remote, id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const,
      url: null, command: "node",
    }], async () => { throw new Error("must not be called"); }));
    await expect(call(host, "servers_connect", { id: "echo", redirectOrigin: "https://bb.example" }))
      .rejects.toThrow(/stdio/i);
  });
});

/**
 * Static request headers, the way a remote server that does not speak OAuth is
 * authenticated. The header value is the credential, so the paths that matter
 * are the ones where a bad one gets in or an old one keeps being sent.
 */
describe("rpc servers_set_headers", () => {
  const remote: ServerRecord = {
    id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
    url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
    cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  };

  function deps(servers: ServerRecord[], dropClient: RpcDeps["dropClient"]): RpcDeps {
    const handle = new Database(":memory:");
    for (const statement of MCP_MIGRATIONS) handle.exec(statement);
    const registry = createRegistry(handle);
    for (const server of servers) registry.upsertServer(server);
    return {
      registry,
      catalog: { sync: async () => [], syncAll: async () => {} },
      pool: { listTools: async () => [] },
      oauth: {
        begin: async () => ({ authorizeUrl: "" }),
        complete: async () => ({ serverId: "notion" }),
        status: () => "disconnected" as const,
        forget: () => {},
        registeredRedirectUri: () => null,
      },
      onAuthChanged: () => {},
      stderrTail: () => [],
      onCatalogChanged: () => {},
      onSelectionChanged: () => {},
      dropClient,
    };
  }

  it("persists headers and drops the pooled client", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const dropped: string[] = [];
    registerRpc(host.bb, deps([remote], async (serverId) => { dropped.push(serverId); }));
    await call(host, "servers_set_headers", {
      id: "notion", headers: { "X-Api-Key": "k" },
    });
    expect((await call(host, "servers_list", null)).servers[0].headers)
      .toEqual({ "X-Api-Key": "k" });
    // Streamable HTTP bakes headers in at construction: without this the open
    // client goes on sending the header the user just replaced.
    expect(dropped).toEqual(["notion"]);
  });

  it("switches a server off and on, and drops its client when it goes off", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const dropped: string[] = [];
    registerRpc(host.bb, deps([remote], async (serverId) => { dropped.push(serverId); }));
    await call(host, "servers_set_enabled", { id: "notion", enabled: false });
    expect((await call(host, "servers_list", null)).servers[0].enabled).toBe(false);
    expect(dropped).toEqual(["notion"]);
    await call(host, "servers_set_enabled", { id: "notion", enabled: true });
    expect((await call(host, "servers_list", null)).servers[0].enabled).toBe(true);
    expect(dropped).toEqual(["notion"]);
  });

  it("refuses to switch an unknown server", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    registerRpc(host.bb, deps([], async () => {}));
    await expect(call(host, "servers_set_enabled", { id: "nope", enabled: false }))
      .rejects.toThrow();
  });

  it("refuses a stdio server, which sends no requests", async () => {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    registerRpc(host.bb, deps([{
      ...remote, id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const,
      url: null, command: "node",
    }], async () => {}));
    await expect(call(host, "servers_set_headers", { id: "echo", headers: {} }))
      .rejects.toThrow(/stdio/i);
  });

  it("rejects a value carrying a newline, which would splice in a header", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
    });
    await expect(call(active, "servers_set_headers", {
      id: "notion", headers: { Authorization: "Bearer k\nX-Admin: 1" },
    })).rejects.toThrow();
    await expect(call(active, "servers_set_headers", {
      id: "notion", headers: { "Bad Name": "k" },
    })).rejects.toThrow();
  });

  it("takes headers when a remote server is added", async () => {
    const active = await load();
    const added = await call(active, "servers_add", {
      displayName: "VL", kind: "remote" as const, url: "https://vl/mcp",
      headers: { Authorization: "Bearer k" },
    });
    expect(added.server.headers).toEqual({ Authorization: "Bearer k" });
  });
});

/**
 * What the removal path owes the user about credentials rather than the
 * catalog.
 */
describe("rpc credentials", () => {
  it("deletes a removed server's stored OAuth credentials", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
    });
    const tokens = createOAuthStore(active.bb.storage.database());
    tokens.putTokens({
      serverId: "notion", accessToken: "at", refreshToken: "rt",
      expiresIn: 3600, obtainedAt: Date.now(), scope: null,
    });
    expect(tokens.getTokens("notion")).toBeDefined();

    await call(active, "servers_remove", { id: "notion" });
    // Plaintext access and refresh tokens for a server the user deleted, with
    // no surface left that could ever remove them.
    expect(tokens.getTokens("notion")).toBeUndefined();
  });

});

/**
 * The panel's cost readout. A tool is paid for in schema before a thread says
 * anything, and the byte count that used to stand in for that priced only the
 * schema - not the description, which a server is free to make as long as it
 * likes and which ships to the model exactly as written.
 */
describe("rpc token estimate", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string", description: "what to look for" } },
  };
  const schemaChars = JSON.stringify(schema).length;

  /** Every tool carries the same schema, so only the other two inputs vary. */
  function toolsFrom(
    entries: Array<{ upstreamName: string; registeredName: string; description: string }>,
  ): Promise<Output<"tools_list">> {
    host = createFakePluginHost({ pluginId: "mcp-hub" });
    const handle = new Database(":memory:");
    for (const statement of MCP_MIGRATIONS) handle.exec(statement);
    const registry = createRegistry(handle);
    registry.upsertServer({
      id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
      url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
      cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    registry.replaceCatalog("notion", entries.map((entry) => ({
      serverId: "notion", ...entry, inputSchema: schema,
      readOnly: true, defaultEnabled: false, stale: false, syncedAt: 1,
    })));
    registerRpc(host.bb, {
      registry,
      catalog: { sync: async () => [], syncAll: async () => {} },
      pool: { listTools: async () => [] },
      oauth: {
        begin: async () => ({ authorizeUrl: "https://auth.example/authorize" }),
        complete: async () => ({ serverId: "notion" }),
        status: () => "disconnected" as const,
        forget: () => {},
        registeredRedirectUri: () => null,
      },
      onAuthChanged: () => {},
      stderrTail: () => [],
      onCatalogChanged: () => {},
      onSelectionChanged: () => {},
      dropClient: async () => {},
    });
    return call(host, "tools_list", {});
  }

  it("charges a long description, which the byte count ignored entirely", async () => {
    const { tools } = await toolsFrom([
      {
        upstreamName: "search", registeredName: "notion_search",
        description: "Search. ",
      },
      {
        // Names of equal length and one schema between them, so the 3200
        // extra characters of prose are the only thing that can move the
        // number - and 3200 of them is exactly 800 tokens.
        upstreamName: "create", registeredName: "notion_create",
        description: "Search. ".repeat(401),
      },
    ]);
    const byName = new Map(tools.map((entry) => [entry.registeredName, entry]));
    const terse = byName.get("notion_search");
    const verbose = byName.get("notion_create");
    expect(terse?.schemaBytes).toBe(verbose?.schemaBytes);
    expect((verbose?.estimatedTokens ?? 0) - (terse?.estimatedTokens ?? 0)).toBe(800);
  });

  it("prices the name a collision renamed, not the one upstream chose", async () => {
    const { tools } = await toolsFrom([{
      upstreamName: "search", registeredName: "notion_search",
      description: "Search Notion pages",
    }]);
    // A prefixed name is what ships to the model; `search` never leaves here.
    expect(tools[0].estimatedTokens).toBe(Math.ceil(
      ("notion_search".length + "Search Notion pages".length + schemaChars) / 4,
    ));
  });
});

/**
 * The manual OAuth client, per server. It used to be two plugin-wide settings
 * named after Google, which could describe exactly one server: not Slack as
 * well, not a self-hosted deployment, not a second Google account.
 */
describe("rpc servers_set_oauth_client", () => {
  it("stores the client and destroys the grant it invalidates", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
    });
    const store = createOAuthStore(active.bb.storage.database());
    store.putTokens({
      serverId: "notion", accessToken: "at", refreshToken: "rt",
      expiresIn: 3600, obtainedAt: Date.now(), scope: null,
    });
    store.putClient({
      serverId: "notion", resourceUrl: "https://mcp.notion.com/mcp",
      authorizationEndpoint: "https://as.example/authorize",
      tokenEndpoint: "https://as.example/token", registrationEndpoint: null,
      clientId: "old-id", clientSecret: null,
      redirectUri: "http://127.0.0.1:38886/cb", createdAt: 1,
    });

    expect(await call(active, "servers_set_oauth_client", {
      id: "notion", clientId: "gcp-id", clientSecret: "gcp-secret",
      scopes: "gmail.readonly",
    })).toEqual({ ok: true });

    const { servers } = await call(active, "servers_list", null);
    expect(servers[0]).toMatchObject({
      oauthClientId: "gcp-id", hasOauthClientSecret: true,
      oauthScopes: "gmail.readonly",
    });
    // A token minted for another client id is not one these credentials can
    // go on using, and a client row that still names the old id would be
    // reused by `begin` in preference to the new one.
    expect(store.getTokens("notion")).toBeUndefined();
    expect(store.getClient("notion")).toBeUndefined();
  });

  it("never puts the client secret in a servers_list response", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
      oauthClientId: "gcp-id", oauthClientSecret: "gcp-secret",
    });
    const listed = await call(active, "servers_list", null);
    // This payload is fetched on every panel render and on every realtime
    // signal; a secret in it is a secret in every network log of one.
    expect(JSON.stringify(listed)).not.toContain("gcp-secret");
    expect(listed.servers[0].hasOauthClientSecret).toBe(true);
  });

  it("keeps the stored secret when the panel sends null for it", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
      oauthClientId: "gcp-id", oauthClientSecret: "gcp-secret",
    });
    // What an edit to the client id alone looks like: the panel is never told
    // the secret, so it has nothing to send back.
    await call(active, "servers_set_oauth_client", {
      id: "notion", clientId: "gcp-id-2", clientSecret: null, scopes: null,
    });
    const registry = createRegistry(active.bb.storage.database());
    expect(registry.getServer("notion")).toMatchObject({
      oauthClientId: "gcp-id-2", oauthClientSecret: "gcp-secret",
    });
  });

  it("clears the stored secret when an empty string is sent", async () => {
    const active = await load();
    await call(active, "servers_add", {
      displayName: "Notion", kind: "remote" as const, url: "https://mcp.notion.com/mcp",
      oauthClientId: "gcp-id", oauthClientSecret: "gcp-secret",
    });
    await call(active, "servers_set_oauth_client", {
      id: "notion", clientId: "", clientSecret: "", scopes: "",
    });
    const registry = createRegistry(active.bb.storage.database());
    expect(registry.getServer("notion")).toMatchObject({
      oauthClientId: "", oauthClientSecret: "", oauthScopes: "",
      authError: null, authErrorAt: null,
    });
    expect((await call(active, "servers_list", null)).servers[0].hasOauthClientSecret)
      .toBe(false);
  });

  it("refuses a stdio server, which has nothing to authorize", async () => {
    const active = await load();
    await addEcho(active);
    await expect(call(active, "servers_set_oauth_client", {
      id: "echo", clientId: "gcp-id", clientSecret: null, scopes: null,
    })).rejects.toThrow(/stdio/i);
  });

  it("reports the redirect uri the stored client was registered with", async () => {
    const active = await load();
    await addRemote(active, "Notion", "https://mcp.notion.com/mcp");
    const { servers } = await call(active, "servers_list", null);
    // The panel compares this with the URI the browser it is running in would
    // produce; a server that has never been connected has none to compare.
    expect(servers.find((server) => server.id === "notion")?.registeredRedirectUri)
      .toBeNull();
  });
});
