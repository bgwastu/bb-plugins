// What one thread's session is offered.
//
// Two layers, and only two: the global switch on a server or a tool (the
// management page) and this thread's own overrides (the footer popup). An
// override wins where it exists; where it does not, the thread follows the
// global answer, so a tool added or turned on later reaches threads that never
// expressed an opinion - which is the whole reason the old default-off
// behaviour felt broken.
import type { ServerRecord, Store, ToolRecord } from "../storage/store.js";

/** Provider sessions are capped at 256 plugin tools. */
export const TOOL_LIMIT = 256;

export interface Overrides {
  servers: Record<string, boolean>;
  tools: Record<string, boolean>;
}

export interface SelectedTool {
  server: ServerRecord;
  tool: ToolRecord;
}

export interface Selection {
  servers: ServerRecord[];
  /** Ordered: servers in configuration order, tools in name order. */
  tools: SelectedTool[];
  /** How many tools would have been offered before the provider cap. */
  offered: number;
  truncated: boolean;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "boolean") result[key] = item;
  }
  return result;
}

/**
 * Reads this thread's overrides out of its plugin metadata.
 *
 * The metadata is writable by any client and by the thread's own agent, so
 * every value is treated as untrusted: anything that is not a boolean is
 * ignored rather than coerced, and the shape never decides an outcome on its
 * own.
 */
export function readOverrides(metadata: Record<string, unknown>): Overrides {
  return {
    servers: booleanRecord(metadata.servers),
    tools: booleanRecord(metadata.tools),
  };
}

export function serverEnabled(server: ServerRecord, overrides: Overrides): boolean {
  return overrides.servers[server.id] ?? server.enabled;
}

export function toolEnabled(tool: ToolRecord, server: ServerRecord, overrides: Overrides): boolean {
  if (!serverEnabled(server, overrides)) return false;
  return overrides.tools[tool.name] ?? tool.enabled;
}

export function resolveSelection(
  store: Store,
  metadata: Record<string, unknown>,
  registered: ReadonlySet<string> | null = null,
  limit: number = TOOL_LIMIT,
): Selection {
  const overrides = readOverrides(metadata);
  const servers = store.listServers();
  const available = servers.filter((server) => serverEnabled(server, overrides));
  const tools: SelectedTool[] = [];
  let offered = 0;

  for (const server of available) {
    for (const tool of store.listTools(server.id)) {
      if (tool.missing) continue;
      if (!toolEnabled(tool, server, overrides)) continue;
      // A name BB refused to register cannot be selected: one unknown id
      // rejects the plugin's whole selection, which would leave the thread
      // with no MCP tools at all.
      if (registered !== null && !registered.has(tool.name)) continue;
      offered += 1;
      if (tools.length < limit) tools.push({ server, tool });
    }
  }

  return { servers: available, tools, offered, truncated: offered > limit };
}

/** The tool names a session should select for this thread. */
export function selectedNames(selection: Selection): string[] {
  return selection.tools.map(({ tool }) => tool.name);
}
