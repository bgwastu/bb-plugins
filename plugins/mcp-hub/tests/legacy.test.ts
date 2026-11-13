import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { importLegacy } from "../src/storage/legacy.js";
import { createStore } from "../src/storage/store.js";
import { createSecretStore } from "../src/storage/secrets.js";
import { memoryDatabase } from "./helpers.js";

/**
 * A 0.1 database as it looks after that version's own migrations ran: every old
 * table is present, and nothing from the rewrite is.
 */
function legacyDatabase(): Database.Database {
  return memoryDatabase();
}

describe("legacy import", () => {
  it("moves servers, tools and credentials into the new layout", () => {
    const db = legacyDatabase();
    db.prepare(`
      INSERT INTO servers (id, display_name, transport, url, command, args, env, cwd, enabled,
        created_at, headers, kind, oauth_client_secret)
      VALUES ('linear', 'Linear', 'http', 'https://mcp.linear.app/mcp', NULL, '[]', '{}', NULL, 1,
        100, '{"X-Team":"a"}', 'remote', 'manual')
    `).run();
    db.prepare(`
      INSERT INTO servers (id, display_name, transport, url, command, args, env, cwd, enabled,
        created_at, kind)
      VALUES ('local', 'Local', 'stdio', NULL, 'npx', '["-y","thing"]',
        '{"API_KEY":"secret"}', '/tmp', 0, 200, 'local')
    `).run();
    db.prepare(`
      INSERT INTO tools (server_id, upstream_name, registered_name, description, input_schema,
        read_only, stale, synced_at)
      VALUES ('linear', 'create_issue', 'linear_create_issue', 'Create', '{"type":"object"}', 0, 0, 300)
    `).run();
    db.prepare(`
      INSERT INTO oauth_tokens (server_id, access_token, refresh_token, scope, expires_in)
      VALUES ('linear', 'at', 'rt', 'read', 3600)
    `).run();
    db.prepare(`
      INSERT INTO oauth_clients (server_id, resource_url, authorization_endpoint, token_endpoint,
        client_id, client_secret, redirect_uri, created_at)
      VALUES ('linear', 'https://mcp.linear.app', 'https://auth/a', 'https://auth/t',
        'cid', 'csecret', 'https://bb/plugins/mcp-hub/mcp-hub/oauth/callback', 100)
    `).run();

    const secrets = createSecretStore(null);
    const result = importLegacy(db, secrets);
    expect(result).toEqual({ servers: 2, tools: 1, tokens: 1 });

    const store = createStore(db);
    const linear = store.getServer("linear");
    expect(linear?.auth).toBe("oauth");
    expect(linear?.name).toBe("Linear");
    expect(linear?.transport).toBe("http");

    const local = store.getServer("local");
    expect(local?.args).toEqual(["-y", "thing"]);
    expect(local?.cwd).toBe("/tmp");
    expect(local?.enabled).toBe(false);
    expect(local?.auth).toBe("none");

    expect(store.listTools("linear")[0]).toMatchObject({
      upstreamName: "create_issue",
      name: "linear_create_issue",
      enabled: true,
    });

    const linearSecrets = secrets.get("linear");
    expect(linearSecrets.headers).toEqual({ "X-Team": "a" });
    // The manual secret (a client someone registered by hand) is separate from
    // the one dynamic registration stored.
    expect(linearSecrets.oauthClientSecret).toBe("manual");
    expect(linearSecrets.oauth?.tokens).toMatchObject({ access_token: "at", refresh_token: "rt" });
    expect(linearSecrets.oauth?.client).toMatchObject({ client_id: "cid", client_secret: "csecret" });
    expect(secrets.get("local").env).toEqual({ API_KEY: "secret" });
  });

  it("does nothing when there is no old data", () => {
    const db = memoryDatabase();
    const secrets = createSecretStore(null);
    expect(importLegacy(db, secrets)).toEqual({ servers: 0, tools: 0, tokens: 0 });
  });

  it("does not move anything twice", () => {
    const db = legacyDatabase();
    db.prepare(`
      INSERT INTO servers (id, display_name, transport, url, command, args, env, cwd, enabled,
        created_at, kind)
      VALUES ('one', 'One', 'stdio', NULL, 'node', '[]', '{}', NULL, 1, 100, 'local')
    `).run();
    const secrets = createSecretStore(null);
    expect(importLegacy(db, secrets).servers).toBe(1);
    expect(importLegacy(db, secrets).servers).toBe(0);
    expect(createStore(db).listServers()).toHaveLength(1);
  });
});
