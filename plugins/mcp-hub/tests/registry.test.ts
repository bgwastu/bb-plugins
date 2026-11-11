import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";
import { createRegistry } from "../src/storage/registry.js";

function db() {
  const handle = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) handle.exec(statement);
  return handle;
}

describe("registry", () => {
  it("round-trips a server and its catalog", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "notion", displayName: "Notion", transport: "http", kind: "remote" as const,
      url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
      cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    registry.replaceCatalog("notion", [{
      serverId: "notion", upstreamName: "notion-search",
      registeredName: "notion-search", description: "Search",
      inputSchema: { type: "object" }, readOnly: true, defaultEnabled: false, stale: false, syncedAt: 1,
    }]);
    expect(registry.listTools("notion")).toHaveLength(1);
    expect(registry.getToolByRegisteredName("notion-search")?.readOnly).toBe(true);
  });

  it("replaces a server's headers wholesale, so a deleted one stops being sent", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "vl", displayName: "VL", transport: "http", kind: "remote" as const, url: "https://vl/mcp",
      command: null, args: [], env: {},
      headers: { Authorization: "Bearer one", "X-Tenant": "acme" },
      cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    expect(registry.getServer("vl")?.headers)
      .toEqual({ Authorization: "Bearer one", "X-Tenant": "acme" });

    registry.setServerHeaders("vl", { Authorization: "Bearer two" });
    expect(registry.getServer("vl")?.headers).toEqual({ Authorization: "Bearer two" });
  });

  it("marks vanished tools stale instead of deleting them", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "s", displayName: "S", transport: "http", kind: "remote" as const, url: "https://x/mcp",
      command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    const tool = {
      serverId: "s", upstreamName: "gone", registeredName: "gone",
      description: "", inputSchema: { type: "object" }, readOnly: true,
      defaultEnabled: false, stale: false, syncedAt: 1,
    };
    registry.replaceCatalog("s", [tool]);
    registry.replaceCatalog("s", []);
    expect(registry.getToolByRegisteredName("gone")?.stale).toBe(true);
  });

  it("keeps per-project bindings independent", () => {
    const registry = createRegistry(db());
    registry.setBinding("proj_a", "notion-search", true);
    expect(registry.listBindings("proj_a")).toEqual(["notion-search"]);
    expect(registry.listBindings("proj_b")).toEqual([]);
  });

  it("tells a force-off override apart from no override at all", () => {
    const registry = createRegistry(db());
    registry.setBinding("proj_a", "notion-search", false);
    // Both projects are absent from `listBindings`, and only one of them has
    // actually said anything: a default-on tool reaches proj_b and not proj_a.
    expect(registry.listBindings("proj_a")).toEqual([]);
    expect(registry.listBindingStates()).toEqual([
      { projectId: "proj_a", registeredName: "notion-search", enabled: false },
    ]);

    registry.clearBinding("proj_a", "notion-search");
    expect(registry.listBindingStates()).toEqual([]);
  });

  it("forces incoming tools to stale = false regardless of the caller's value", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "s", displayName: "S", transport: "http", kind: "remote" as const, url: "https://x/mcp",
      command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    registry.replaceCatalog("s", [{
      serverId: "s", upstreamName: "present", registeredName: "present",
      description: "", inputSchema: { type: "object" }, readOnly: true,
      defaultEnabled: false, stale: true, syncedAt: 1,
    }]);
    expect(registry.getToolByRegisteredName("present")?.stale).toBe(false);
  });

  it("writes an oauth client without disturbing the rest of the row", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "s", displayName: "S", transport: "http", kind: "remote" as const, url: "https://x/mcp",
      command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });

    registry.setServerOAuthClient("s", {
      clientId: "gcp-id", clientSecret: "gcp-secret", scopes: "a b",
    });
    // An UPDATE rather than a read-modify-upsert: `upsertServer` writes
    // `created_at = excluded.created_at`, so every field it does not need to
    // touch is one it could get wrong.
    expect(registry.getServer("s")).toMatchObject({
      createdAt: 1, oauthClientId: "gcp-id", oauthClientSecret: "gcp-secret",
      oauthScopes: "a b",
      authError: null, authErrorAt: null,
    });

    // Null leaves a field alone; an empty string clears it. Without that
    // distinction the panel, which is never told the secret, would wipe it
    // every time the client id was corrected.
    registry.setServerOAuthClient("s", {
      clientId: "gcp-id-2", clientSecret: null, scopes: null,
    });
    expect(registry.getServer("s")).toMatchObject({
      oauthClientId: "gcp-id-2", oauthClientSecret: "gcp-secret", oauthScopes: "a b",
      authError: null, authErrorAt: null,
    });

    registry.setServerOAuthClient("s", { clientId: null, clientSecret: "", scopes: null });
    expect(registry.getServer("s")?.oauthClientSecret).toBe("");
  });

  it("cascades server deletion to its tools and bindings", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "s", displayName: "S", transport: "http", kind: "remote" as const, url: "https://x/mcp",
      command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    registry.replaceCatalog("s", [{
      serverId: "s", upstreamName: "tool-a", registeredName: "tool-a",
      description: "", inputSchema: { type: "object" }, readOnly: true,
      defaultEnabled: false, stale: false, syncedAt: 1,
    }]);
    registry.setBinding("proj_a", "tool-a", true);

    registry.deleteServer("s");

    expect(registry.listTools()).toEqual([]);
    expect(registry.getToolByRegisteredName("tool-a")).toBeUndefined();
    expect(registry.listBindings("proj_a")).not.toContain("tool-a");
  });

  it("drops the dead binding rows an upgrade would turn into refusals", () => {
    // The rows this deletes were written by a panel that had no way to say
    // "off": before defaults existed only `enabled = 1` was ever read back.
    // Carrying them across the upgrade would read them as a standing refusal
    // and quietly withhold the first default the user turns on.
    const handle = new Database(":memory:");
    // Found by its content, not by position: migrations are appended, and
    // pinning this to the end of the list makes the next append fail here.
    const upgradeIndex = MCP_MIGRATIONS
      .findIndex((statement) => statement.includes("DELETE FROM bindings"));
    const upgrade = MCP_MIGRATIONS[upgradeIndex];
    for (const statement of MCP_MIGRATIONS.slice(0, upgradeIndex)) handle.exec(statement);
    handle.exec(`
      INSERT INTO bindings (project_id, registered_name, enabled)
      VALUES ('proj_personal', 'notion-fetch', 0), ('proj_personal', 'notion-search', 1);
    `);

    handle.exec(upgrade);

    expect(handle.prepare("SELECT registered_name FROM bindings").all())
      .toEqual([{ registered_name: "notion-search" }]);
    // Only the upgrade is amnestied. An off written from here on is a choice.
    for (const statement of MCP_MIGRATIONS.slice(upgradeIndex + 1)) handle.exec(statement);
    createRegistry(handle).setBinding("proj_personal", "notion-fetch", false);
    expect(handle.prepare("SELECT COUNT(*) AS n FROM bindings").get())
      .toEqual({ n: 2 });
  });

  it("drops the consent columns an upgrade left behind", () => {
    // Nothing reads `ask` any more, so the columns go rather than sit there as
    // a trap for whoever writes the next read. Found by content, not position,
    // for the same reason as the test above: migrations are appended.
    const handle = new Database(":memory:");
    const dropIndex = MCP_MIGRATIONS
      .findIndex((statement) => statement.includes("DROP COLUMN ask"));
    expect(dropIndex).toBeGreaterThan(-1);
    for (const statement of MCP_MIGRATIONS.slice(0, dropIndex)) handle.exec(statement);
    // A row with both columns set, so the drop runs against real data.
    handle.prepare(`
      INSERT INTO tools (server_id, upstream_name, registered_name, description,
        input_schema, read_only, ask, ask_overridden, stale, synced_at)
      VALUES ('s', 'send-mail', 'send-mail', 'Send', '{}', 0, 1, 1, 0, 1)
    `).run();

    handle.exec(MCP_MIGRATIONS[dropIndex]);

    const columns = handle.prepare("SELECT name FROM pragma_table_info('tools')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("ask");
    expect(columns.map((column) => column.name)).not.toContain("ask_overridden");
    // The row survives; only the columns go.
    expect(handle.prepare("SELECT registered_name FROM tools").all())
      .toEqual([{ registered_name: "send-mail" }]);
  });
});

describe("a server's connection kind", () => {
  it("backfills a row written before the column existed", () => {
    const handle = db();
    // Straight into the table, the way migration 14 finds an existing row:
    // through the registry it would arrive with a kind already set.
    handle.prepare(`
      INSERT INTO servers (id, display_name, transport, kind, url, command, args, env, cwd,
        headers, enabled, created_at)
      VALUES ('old', 'Old', 'stdio', '', NULL, 'npx', '[]', '{}', NULL, '{}', 1, 1)
    `).run();
    expect(createRegistry(handle).getServer("old")?.kind).toBe("local");
  });
});

describe("recording why a connection stopped working", () => {
  function withServer() {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "executor", displayName: "Executor", transport: "http", kind: "gateway",
      url: "https://executor.test/mcp", command: null, args: [], env: {}, headers: {},
      cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    return registry;
  }

  it("keeps the first timestamp while the reason is unchanged", () => {
    const registry = withServer();
    registry.setAuthError("executor", "Grant not found");
    const first = registry.getServer("executor")?.authErrorAt;
    registry.setAuthError("executor", "Grant not found");
    // The background sweep rediscovers the same dead grant every seventeen
    // minutes; a timestamp bumped each time would report a four-day outage as
    // one that started a moment ago.
    expect(registry.getServer("executor")?.authErrorAt).toBe(first);
  });

  it("clears the timestamp with the reason", () => {
    const registry = withServer();
    registry.setAuthError("executor", "Grant not found");
    registry.setAuthError("executor", null);
    expect(registry.getServer("executor")).toMatchObject({
      authError: null, authErrorAt: null,
    });
  });
});
