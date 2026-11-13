// The plugin's durable state: configured servers, the tools each one
// advertised at its last sync, and a short call log. Credentials are not here
// (see secrets.ts).
import type Database from "better-sqlite3";
import { toolName } from "../mcp/naming.js";

export type Transport = "stdio" | "http";
export type AuthType = "none" | "bearer" | "headers" | "oauth";

export interface ServerRecord {
  id: string;
  name: string;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  auth: AuthType;
  oauthClientId: string | null;
  oauthScopes: string | null;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface ToolRecord {
  serverId: string;
  upstreamName: string;
  /** The name registered with BB and shown to the model. */
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** The global default; a thread can override it. */
  enabled: boolean;
  /** The server no longer advertises it. */
  missing: boolean;
  syncedAt: number;
}

export interface DiscoveredTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface CallRecord {
  id: number;
  at: number;
  serverId: string;
  tool: string;
  threadId: string | null;
  ok: boolean;
  durationMs: number;
  error: string | null;
}

const CALL_LOG_PER_SERVER = 200;

interface ServerRow {
  id: string; name: string; transport: string; url: string | null; command: string | null;
  args: string; cwd: string | null; auth: string; oauth_client_id: string | null;
  oauth_scopes: string | null; enabled: number; created_at: number; last_seen_at: number | null;
}

interface ToolRow {
  server_id: string; upstream_name: string; name: string; title: string | null;
  description: string; input_schema: string; read_only: number; enabled: number;
  missing: number; synced_at: number;
}

interface CallRow {
  id: number; at: number; server_id: string; tool: string; thread_id: string | null;
  ok: number; duration_ms: number; error: string | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toServer(row: ServerRow): ServerRecord {
  return {
    id: row.id, name: row.name, transport: row.transport === "stdio" ? "stdio" : "http",
    url: row.url, command: row.command, args: parseJson<string[]>(row.args, []), cwd: row.cwd,
    auth: (["none", "bearer", "headers", "oauth"] as const).find((value) => value === row.auth) ?? "none",
    oauthClientId: row.oauth_client_id, oauthScopes: row.oauth_scopes,
    enabled: row.enabled === 1, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
  };
}

function toTool(row: ToolRow): ToolRecord {
  return {
    serverId: row.server_id, upstreamName: row.upstream_name, name: row.name, title: row.title,
    description: row.description,
    inputSchema: parseJson<Record<string, unknown>>(row.input_schema, { type: "object" }),
    readOnly: row.read_only === 1, enabled: row.enabled === 1, missing: row.missing === 1,
    syncedAt: row.synced_at,
  };
}

export interface Store {
  listServers(): ServerRecord[];
  getServer(id: string): ServerRecord | null;
  saveServer(server: ServerRecord): void;
  removeServer(id: string): void;
  setServerEnabled(id: string, enabled: boolean): void;
  touchServer(id: string, at: number): void;
  listTools(serverId?: string): ToolRecord[];
  getTool(name: string): ToolRecord | null;
  /** Replaces a server's tool list; returns whether anything changed. */
  syncTools(serverId: string, discovered: DiscoveredTool[], at: number): boolean;
  setToolsEnabled(names: string[], enabled: boolean): number;
  recordCall(call: Omit<CallRecord, "id">): void;
  listCalls(serverId: string, limit: number): CallRecord[];
}

export function createStore(db: Database.Database): Store {
  const listTools = (serverId?: string): ToolRecord[] => {
    const rows = serverId === undefined
      ? db.prepare("SELECT * FROM hub_tools ORDER BY server_id, upstream_name").all()
      : db.prepare("SELECT * FROM hub_tools WHERE server_id = ? ORDER BY upstream_name").all(serverId);
    return (rows as ToolRow[]).map(toTool);
  };

  return {
    listServers: () =>
      (db.prepare("SELECT * FROM hub_servers ORDER BY created_at, id").all() as ServerRow[]).map(toServer),
    getServer(id) {
      const row = db.prepare("SELECT * FROM hub_servers WHERE id = ?").get(id) as ServerRow | undefined;
      return row ? toServer(row) : null;
    },
    saveServer(server) {
      db.prepare(`
        INSERT INTO hub_servers
          (id, name, transport, url, command, args, cwd, auth, oauth_client_id, oauth_scopes,
           enabled, created_at, last_seen_at)
        VALUES (@id, @name, @transport, @url, @command, @args, @cwd, @auth, @oauthClientId,
                @oauthScopes, @enabled, @createdAt, @lastSeenAt)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name, transport = excluded.transport, url = excluded.url,
          command = excluded.command, args = excluded.args, cwd = excluded.cwd,
          auth = excluded.auth, oauth_client_id = excluded.oauth_client_id,
          oauth_scopes = excluded.oauth_scopes, enabled = excluded.enabled
      `).run({ ...server, args: JSON.stringify(server.args), enabled: server.enabled ? 1 : 0 });
    },
    removeServer(id) {
      db.transaction(() => {
        db.prepare("DELETE FROM hub_servers WHERE id = ?").run(id);
        db.prepare("DELETE FROM hub_tools WHERE server_id = ?").run(id);
        db.prepare("DELETE FROM hub_calls WHERE server_id = ?").run(id);
      })();
    },
    setServerEnabled(id, enabled) {
      db.prepare("UPDATE hub_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    },
    touchServer(id, at) {
      db.prepare("UPDATE hub_servers SET last_seen_at = ? WHERE id = ?").run(at, id);
    },
    listTools,
    getTool(name) {
      const row = db.prepare("SELECT * FROM hub_tools WHERE name = ?").get(name) as ToolRow | undefined;
      return row ? toTool(row) : null;
    },
    syncTools(serverId, discovered, at) {
      let changed = false;
      db.transaction(() => {
        const existing = new Map(listTools(serverId).map((tool) => [tool.upstreamName, tool]));
        const taken = new Set(
          (db.prepare("SELECT name FROM hub_tools").all() as { name: string }[]).map((row) => row.name),
        );
        const seen = new Set<string>();
        for (const tool of discovered) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          const prior = existing.get(tool.name);
          const schema = JSON.stringify(tool.inputSchema);
          if (!prior) {
            const name = toolName(serverId, tool.name, taken);
            taken.add(name);
            db.prepare(`
              INSERT INTO hub_tools
                (server_id, upstream_name, name, title, description, input_schema, read_only,
                 enabled, missing, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)
            `).run(serverId, tool.name, name, tool.title, tool.description, schema, tool.readOnly ? 1 : 0, at);
            changed = true;
            continue;
          }
          if (
            prior.missing || prior.title !== tool.title || prior.description !== tool.description
            || prior.readOnly !== tool.readOnly || JSON.stringify(prior.inputSchema) !== schema
          ) {
            changed = true;
          }
          db.prepare(`
            UPDATE hub_tools SET title = ?, description = ?, input_schema = ?, read_only = ?,
              missing = 0, synced_at = ?
            WHERE server_id = ? AND upstream_name = ?
          `).run(tool.title, tool.description, schema, tool.readOnly ? 1 : 0, at, serverId, tool.name);
        }
        for (const prior of existing.values()) {
          if (seen.has(prior.upstreamName) || prior.missing) continue;
          db.prepare("UPDATE hub_tools SET missing = 1 WHERE server_id = ? AND upstream_name = ?")
            .run(serverId, prior.upstreamName);
          changed = true;
        }
      })();
      return changed;
    },
    setToolsEnabled(names, enabled) {
      const statement = db.prepare("UPDATE hub_tools SET enabled = ? WHERE name = ?");
      let updated = 0;
      db.transaction(() => {
        for (const name of names) updated += statement.run(enabled ? 1 : 0, name).changes;
      })();
      return updated;
    },
    recordCall(call) {
      db.prepare(`
        INSERT INTO hub_calls (at, server_id, tool, thread_id, ok, duration_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(call.at, call.serverId, call.tool, call.threadId, call.ok ? 1 : 0, call.durationMs, call.error);
      db.prepare(`
        DELETE FROM hub_calls WHERE server_id = ? AND id <= (
          SELECT id FROM hub_calls WHERE server_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?
        )
      `).run(call.serverId, call.serverId, CALL_LOG_PER_SERVER);
    },
    listCalls(serverId, limit) {
      const rows = db.prepare("SELECT * FROM hub_calls WHERE server_id = ? ORDER BY id DESC LIMIT ?")
        .all(serverId, limit) as CallRow[];
      return rows.map((row) => ({
        id: row.id, at: row.at, serverId: row.server_id, tool: row.tool, threadId: row.thread_id,
        ok: row.ok === 1, durationMs: row.duration_ms, error: row.error,
      }));
    },
  };
}
