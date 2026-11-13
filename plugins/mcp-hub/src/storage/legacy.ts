// One-time import of the 0.1 layout into the rewrite's tables.
//
// The old tables are left in place: they are the only copy of a working
// configuration if this import turns out to be wrong, and nothing reads them
// after the flag is set. Credentials move to the secrets file, because the old
// ones were stored as plain columns in SQLite - which is the habit this
// rewrite is meant to end, not repeat on the way in.
import type Database from "better-sqlite3";
import type { SecretStore, ServerSecrets } from "./secrets.js";
import { toolName } from "../mcp/naming.js";
import type { AuthType, ServerRecord, Transport } from "./store.js";

interface LegacyServerRow {
  id: string;
  display_name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  env: string | null;
  cwd: string | null;
  enabled: number;
  created_at: number;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string | null;
  headers: string | null;
}

interface LegacyToolRow {
  server_id: string;
  upstream_name: string;
  registered_name: string;
  description: string | null;
  input_schema: string | null;
  read_only: number;
  stale: number;
  synced_at: number;
  default_enabled: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function parseObject(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function parseStringArray(text: string | null): string[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseSchema(text: string | null): Record<string, unknown> {
  if (!text) return { type: "object" };
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { type: "object" };
  } catch {
    return { type: "object" };
  }
}

function authFor(row: LegacyServerRow, secrets: ServerSecrets): AuthType {
  // A client id or a stored grant is an unambiguous statement of intent; a
  // bearer or a header is inferred from what was actually configured.
  if (row.oauth_client_id || secrets.oauth?.tokens || secrets.oauth?.client) return "oauth";
  if (secrets.bearer) return "bearer";
  if (Object.keys(secrets.headers ?? {}).length > 0) return "headers";
  return "none";
}

export interface ImportResult {
  servers: number;
  tools: number;
  tokens: number;
}

/**
 * Copies the old configuration into `hub_servers` and `hub_tools`, returning
 * what it moved. Safe to call when there is nothing to move.
 */
export function importLegacy(db: Database.Database, secrets: SecretStore): ImportResult {
  const result: ImportResult = { servers: 0, tools: 0, tokens: 0 };
  if (!tableExists(db, "servers")) return result;
  if (tableExists(db, "hub_servers")) {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM hub_servers").get() as { count: number };
    if (existing.count > 0) return result;
  }

  const rows = db.prepare("SELECT * FROM servers").all() as LegacyServerRow[];
  if (rows.length === 0) return result;

  const legacyTokens = new Map<string, Record<string, unknown>>();
  if (tableExists(db, "oauth_tokens")) {
    const tokenRows = db
      .prepare("SELECT server_id, access_token, refresh_token, expires_in, scope FROM oauth_tokens")
      .all() as {
      server_id: string;
      access_token: string;
      refresh_token: string | null;
      expires_in: number | null;
      scope: string | null;
    }[];
    for (const row of tokenRows) {
      legacyTokens.set(row.server_id, {
        access_token: row.access_token,
        token_type: "Bearer",
        ...(row.refresh_token ? { refresh_token: row.refresh_token } : {}),
        ...(row.expires_in ? { expires_in: row.expires_in } : {}),
        ...(row.scope ? { scope: row.scope } : {}),
      });
    }
  }

  const legacyClients = new Map<string, { client_id: string; client_secret: string | null; redirect_uri: string }>();
  if (tableExists(db, "oauth_clients")) {
    const clientRows = db
      .prepare("SELECT server_id, client_id, client_secret, redirect_uri FROM oauth_clients")
      .all() as { server_id: string; client_id: string; client_secret: string | null; redirect_uri: string }[];
    for (const row of clientRows) legacyClients.set(row.server_id, row);
  }

  db.transaction(() => {
    for (const row of rows) {
      const env = parseObject(row.env);
      const headers = parseObject(row.headers);
      const secretsForServer: ServerSecrets = {
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(row.oauth_client_secret ? { oauthClientSecret: row.oauth_client_secret } : {}),
      };
      const tokens = legacyTokens.get(row.id);
      const client = legacyClients.get(row.id);
      if (tokens || client) {
        secretsForServer.oauth = {
          ...(tokens ? { tokens } : {}),
          ...(client
            ? {
                client: {
                  client_id: client.client_id,
                  ...(client.client_secret ? { client_secret: client.client_secret } : {}),
                },
                redirectUri: client.redirect_uri,
              }
            : {}),
        };
      }
      if (Object.keys(secretsForServer).length > 0) secrets.update(row.id, () => secretsForServer);
      if (tokens) result.tokens += 1;

      const server: ServerRecord = {
        id: row.id,
        name: row.display_name,
        transport: (row.transport === "stdio" ? "stdio" : "http") as Transport,
        url: row.url,
        command: row.command,
        args: parseStringArray(row.args),
        cwd: row.cwd,
        auth: authFor(row, secretsForServer),
        oauthClientId: row.oauth_client_id,
        oauthScopes: row.oauth_scopes,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        lastSeenAt: null,
      };
      db.prepare(`
        INSERT INTO hub_servers
          (id, name, transport, url, command, args, cwd, auth, oauth_client_id, oauth_scopes,
           enabled, created_at, last_seen_at)
        VALUES (@id, @name, @transport, @url, @command, @args, @cwd, @auth, @oauthClientId,
                @oauthScopes, @enabled, @createdAt, @lastSeenAt)
        ON CONFLICT (id) DO NOTHING
      `).run({ ...server, args: JSON.stringify(server.args), enabled: server.enabled ? 1 : 0 });
      result.servers += 1;
    }

    if (!tableExists(db, "tools")) return;
    const taken = new Set<string>();
    const toolRows = db.prepare("SELECT * FROM tools").all() as LegacyToolRow[];
    for (const row of toolRows) {
      const name = toolName(row.server_id, row.upstream_name, taken);
      taken.add(name);
      db.prepare(`
        INSERT INTO hub_tools
          (server_id, upstream_name, name, title, description, input_schema, read_only,
           enabled, missing, synced_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (server_id, upstream_name) DO NOTHING
      `).run(
        row.server_id,
        row.upstream_name,
        name,
        row.description ?? "",
        JSON.stringify(parseSchema(row.input_schema)),
        row.read_only === 1 ? 1 : 0,
        row.stale === 1 ? 1 : 0,
        row.synced_at,
      );
      result.tools += 1;
    }
  })();

  return result;
}
