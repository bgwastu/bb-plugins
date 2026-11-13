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
import { readOverrides, toolEnabled } from "./selection.js";

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
    origin?: string;
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
  /** Forgets a thread's cached overrides, after they were written. */
  invalidate(threadId: string): void;
  /** Whether this thread may call this tool right now. */
  allowed(threadId: string, server: ServerRecord, tool: ToolRecord): Promise<boolean>;
}

const OVERRIDE_TTL_MS = 2000;

export function createToolSurfaces(bb: BbPluginApi, deps: ToolSurfacesDeps): ToolSurfaces {
  const registered = new Set<string>();
  const refused = new Map<string, string>();
  const threadOverrides = new Map<string, { at: number; servers: Record<string, boolean>; tools: Record<string, boolean> }>();

  async function overridesFor(threadId: string) {
    const cached = threadOverrides.get(threadId);
    const now = Date.now();
    if (cached && now - cached.at < OVERRIDE_TTL_MS) return cached;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = (await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown>;
    } catch {
      // A thread that no longer exists has no overrides; the call will fail
      // for its own reason, not this one.
    }
    const overrides = { at: now, ...readOverrides(metadata) };
    threadOverrides.set(threadId, overrides);
    return overrides;
  }

  async function allowed(threadId: string, server: ServerRecord, tool: ToolRecord): Promise<boolean> {
    const overrides = await overridesFor(threadId);
    return toolEnabled(tool, server, overrides);
  }

  function descriptionFor(server: ServerRecord, tool: ToolRecord): string {
    const body = tool.description.trim();
    const title = tool.title?.trim();
    const heading = body.length > 0 ? body : (title && title.length > 0 ? title : `${tool.upstreamName} (no description)`);
    return `${heading}\n\nFrom the MCP server "${server.name}".`;
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
        try {
          bb.agents.registerTool({
            name: tool.name,
            description: descriptionFor(server, tool),
            parameters: normaliseSchema(tool.inputSchema),
            execute: async (params: unknown, ctx: { threadId: string }) => {
              // Turned off from the footer after this session started: the
              // tool is still in the session, so the refusal has to happen
              // here rather than by the name disappearing.
              if (!(await allowed(ctx.threadId, server, tool))) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `"${tool.name}" is turned off for this thread. Turn it back on in the MCP button next to the message box.`,
                    },
                  ],
                  isError: true,
                };
              }
              const outcome = await deps.execute({
                server,
                tool,
                arguments: params,
                threadId: ctx.threadId,
              });
              return { content: outcome.result.content, isError: outcome.result.isError };
            },
          });
          registered.add(tool.name);
          refused.delete(tool.name);
          added.push(tool.name);
        } catch (error) {
          // BB refuses a duplicate name, a recursive schema, or a name another
          // plugin already holds. None of those is worth failing the plugin
          // load over; the panel says which tool was lost and why.
          const reason = error instanceof Error ? error.message : String(error);
          refused.set(tool.name, reason);
          deps.log.warn(`MCP Hub could not register "${tool.name}": ${reason}`);
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
    invalidate: (threadId) => {
      threadOverrides.delete(threadId);
    },
    allowed,
  };
}
