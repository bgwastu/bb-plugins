// The agent side: one native BB tool per MCP tool, registered from the cache.
//
// Registration is deliberately the boring path. Every tool is its own tool, so
// a model calls `linear_create_issue` and not `mcp_call{server, tool}`; the
// name says where it came from; and nothing on this path opens a connection,
// so a dead server cannot slow down a thread start.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ServerRecord, Store, ToolRecord } from "../storage/store.js";
import type { ExecuteOutcome } from "../mcp/execute.js";
import { normaliseSchema, recursiveLocalRef } from "../mcp/validate.js";

export interface ToolProblem {
  name: string;
  reason: string;
}

export interface ToolSurfacesDeps {
  store: Store;
  execute(request: {
    server: ServerRecord;
    tool: ToolRecord;
    arguments: unknown;
    threadId?: string;
  }): Promise<ExecuteOutcome>;
  log: { warn(message: string): void };
}

export interface ToolSurfaces {
  /** Registers every cached tool not already registered. Returns the new names. */
  register(): string[];
  /** Every name this plugin has registered with BB. */
  names(): ReadonlySet<string>;
  /** Tools BB refused, with the reason, for the panel to show. */
  problems(): ToolProblem[];
  /** Why one tool was refused, or null. */
  problem(name: string): string | null;
}

export function createToolSurfaces(bb: BbPluginApi, deps: ToolSurfacesDeps): ToolSurfaces {
  const registered = new Set<string>();
  const refused = new Map<string, string>();

  function descriptionFor(server: ServerRecord, tool: ToolRecord): string {
    const body = tool.description.trim();
    const title = tool.title?.trim();
    const heading = body.length > 0 ? body : (title && title.length > 0 ? title : `${tool.upstreamName} (no description)`);
    return `${heading}\n\nFrom the MCP server "${server.name}".`;
  }

  /**
   * The live row for a registered name.
   *
   * Read per call, not captured at registration: switching a server or a tool
   * off must take effect immediately, and a registration lives as long as the
   * plugin does.
   */
  function current(serverId: string, name: string): { server: ServerRecord; tool: ToolRecord } | null {
    const server = deps.store.getServer(serverId);
    if (!server) return null;
    const tool = deps.store.listTools(serverId).find((candidate) => candidate.name === name);
    if (!tool) return null;
    return { server, tool };
  }

  function register(): string[] {
    const added: string[] = [];
    for (const server of deps.store.listServers()) {
      for (const tool of deps.store.listTools(server.id)) {
        if (tool.missing || registered.has(tool.name)) continue;
        const cycle = recursiveLocalRef(tool.inputSchema);
        if (cycle !== null) {
          refused.set(
            tool.name,
            `its schema uses ${cycle} recursively, which some providers reject for a whole tool list`,
          );
          continue;
        }
        const serverId = server.id;
        const name = tool.name;
        try {
          bb.agents.registerTool({
            name,
            description: descriptionFor(server, tool),
            parameters: normaliseSchema(tool.inputSchema),
            execute: async (params: unknown, ctx: { threadId: string }) => {
              const live = current(serverId, name);
              if (!live) {
                return {
                  content: [{ type: "text" as const, text: `"${name}" is no longer available.` }],
                  isError: true,
                };
              }
              if (!live.server.enabled) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `The MCP server "${live.server.name}" is turned off, so "${name}" was not called.`,
                    },
                  ],
                  isError: true,
                };
              }
              if (!live.tool.enabled) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `"${name}" is turned off in the MCP settings, so it was not called.`,
                    },
                  ],
                  isError: true,
                };
              }
              const outcome = await deps.execute({
                server: live.server,
                tool: live.tool,
                arguments: params,
                threadId: ctx.threadId,
              });
              return { content: outcome.result.content, isError: outcome.result.isError };
            },
          });
          registered.add(name);
          refused.delete(name);
          added.push(name);
        } catch (error) {
          // BB refuses a duplicate name, a recursive schema, or a name another
          // plugin already holds. None of those is worth failing the plugin
          // load over; the panel says which tool was lost and why.
          const reason = error instanceof Error ? error.message : String(error);
          refused.set(name, reason);
          deps.log.warn(`MCP Hub could not register "${name}": ${reason}`);
        }
      }
    }
    return added;
  }

  return {
    register,
    names: () => registered,
    problems: () => [...refused.entries()].map(([name, reason]) => ({ name, reason })),
    problem: (name) => refused.get(name) ?? null,
  };
}
