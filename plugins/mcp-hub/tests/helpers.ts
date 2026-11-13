import Database from "better-sqlite3";
import type { DiscoveredTool, ServerRecord, ToolRecord } from "../src/storage/store.js";
import { createStore, type Store } from "../src/storage/store.js";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";
import { fileURLToPath } from "node:url";

export function emptyDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}

export function memoryDatabase(): Database.Database {
  const db = emptyDatabase();
  for (const statement of MCP_MIGRATIONS) db.exec(statement);
  return db;
}

export function memoryStore(): { db: Database.Database; store: Store } {
  const db = memoryDatabase();
  return { db, store: createStore(db) };
}

export function serverRecord(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: "echo",
    name: "Echo",
    transport: "stdio",
    url: null,
    command: process.execPath,
    args: [fixture("echo-mcp-server.mjs")],
    cwd: null,
    auth: "none",
    oauthClientId: null,
    oauthScopes: null,
    enabled: true,
    createdAt: 1,
    lastSeenAt: null,
    ...overrides,
  };
}

export function toolRecord(overrides: Partial<ToolRecord> = {}): ToolRecord {
  return {
    serverId: "echo",
    upstreamName: "echo",
    name: "echo_echo",
    title: null,
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    readOnly: false,
    enabled: true,
    missing: false,
    syncedAt: 1,
    ...overrides,
  };
}

export function discovered(overrides: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name: "echo",
    title: null,
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    readOnly: false,
    ...overrides,
  };
}

export function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Inserts a server and its tools through the real write paths. */
export function seed(
  store: Store,
  server: Partial<ServerRecord> = {},
  tools: DiscoveredTool[] = [discovered()],
): ServerRecord {
  const record = serverRecord(server);
  store.saveServer(record);
  store.syncTools(record.id, tools, 1);
  return record;
}
