// What a session is offered, from the one set of switches there is.
//
// A server is on or off for everyone: the management page and the composer
// popup both flip the same row. There is no per-thread layer to reconcile, so
// a tool added or switched on later simply reaches the next session.
import type { ServerRecord, Store, ToolRecord } from "../storage/store.js";

/** Provider sessions are capped at 256 plugin tools. */
export const TOOL_LIMIT = 256;

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

export function resolveSelection(
  store: Store,
  registered: ReadonlySet<string> | null = null,
  limit: number = TOOL_LIMIT,
): Selection {
  const servers = store.listServers().filter((server) => server.enabled);
  const tools: SelectedTool[] = [];
  let offered = 0;

  for (const server of servers) {
    for (const tool of store.listTools(server.id)) {
      if (tool.missing || !tool.enabled) continue;
      // A name BB refused to register cannot be selected: one unknown id
      // rejects the plugin's whole selection, which would leave the thread
      // with no MCP tools at all.
      if (registered !== null && !registered.has(tool.name)) continue;
      offered += 1;
      if (tools.length < limit) tools.push({ server, tool });
    }
  }

  return { servers, tools, offered, truncated: offered > limit };
}
