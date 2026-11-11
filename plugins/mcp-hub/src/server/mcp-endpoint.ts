import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CatalogTool, Registry } from "../storage/registry.js";
import type { ToolExecutor } from "./tools.js";

/** Where the endpoint is mounted, under the plugin's http namespace. */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * The tools an external MCP client may see.
 *
 * Some agents (Antigravity's ACP adapter, for one) never forward the tools BB
 * injects into a thread, so this exposes the hub as an ordinary MCP server they
 * can be pointed at once. A disabled server and a tool the catalog no longer
 * lists are left out for the same reasons they are everywhere else.
 */
export function endpointTools(registry: Registry): CatalogTool[] {
  const enabled = new Set(
    registry.listServers().filter((server) => server.enabled).map((server) => server.id),
  );
  return registry
    .listTools()
    .filter((tool) => enabled.has(tool.serverId) && !tool.stale && tool.defaultEnabled);
}

function buildServer(deps: {
  registry: Registry;
  execute: ToolExecutor;
}): Server {
  const server = new Server(
    { name: "mcp-hub", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: endpointTools(deps.registry).map((tool) => ({
      name: tool.registeredName,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = endpointTools(deps.registry).find(
      (candidate) => candidate.registeredName === request.params.name,
    );
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown or unavailable tool "${request.params.name}".` }],
      };
    }
    const result = await deps.execute(
      tool,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      // No thread or project exists for an external caller.
      { threadId: "", projectId: "", signal: extra.signal },
    );
    if (typeof result === "string") {
      return { content: [{ type: "text" as const, text: result }] };
    }
    return { content: result.content, isError: result.isError === true };
  });
  return server;
}

/**
 * Serves the hub's tools over MCP streamable HTTP.
 *
 * Stateless: every request gets its own server and transport, so there is no
 * session to leak or expire. Token auth, because an open loopback endpoint
 * would let any local process run these tools.
 */
export function registerMcpEndpoint(
  bb: BbPluginApi,
  deps: { registry: Registry; execute: ToolExecutor },
): void {
  const handle = async (context: { req: { raw: Request } }): Promise<Response> => {
    const server = buildServer(deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(context.req.raw);
    } finally {
      void server.close().catch(() => undefined);
    }
  };
  bb.http.route("POST", MCP_ENDPOINT_PATH, handle as never, { auth: "token" });
  // No sessions means nothing to stream to or tear down. A GET answered with an
  // SSE stream that closes at once sends a client into a reconnect loop, so
  // both say 405, which the streamable-HTTP spec tells a client to accept.
  const notAllowed = (): Response =>
    new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  bb.http.route("GET", MCP_ENDPOINT_PATH, notAllowed, { auth: "token" });
  bb.http.route("DELETE", MCP_ENDPOINT_PATH, notAllowed, { auth: "token" });
}
