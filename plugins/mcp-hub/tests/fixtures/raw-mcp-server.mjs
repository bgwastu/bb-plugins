// A low-level MCP server, so a test can send exactly the wire shapes a real
// server sends - including ones the high-level helper will not produce.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "raw-fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

const tools = [
  {
    name: "echo",
    description: "Echo text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "structured",
    description: "Returns text and structure",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fail",
    description: "Always refuses",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "returns-error",
    description: "Returns isError instead of throwing",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recursive",
    description: "A schema some providers reject",
    inputSchema: {
      type: "object",
      properties: {
        node: { $ref: "#/definitions/node" },
      },
      definitions: {
        node: {
          type: "object",
          properties: {
            child: { $ref: "#/definitions/node" },
          },
        },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === "echo") {
    if (typeof args.text !== "string") {
      // The exact class of error that used to kill a pooled client.
      throw new McpError(ErrorCode.InvalidParams, "text must be a string");
    }
    return { content: [{ type: "text", text: args.text }] };
  }
  if (name === "structured") {
    return {
      content: [{ type: "text", text: "summary" }],
      structuredContent: { count: 2, items: ["a", "b"] },
    };
  }
  if (name === "returns-error") {
    return { content: [{ type: "text", text: "it did not work" }], isError: true };
  }
  if (name === "fail") {
    throw new McpError(ErrorCode.InternalError, "the server says no");
  }
  if (name === "recursive") {
    return { content: [{ type: "text", text: "ok" }] };
  }
  throw new McpError(ErrorCode.MethodNotFound, `no tool ${name}`);
});

// One change notification shortly after start, to exercise the listener.
setTimeout(() => {
  server.sendToolListChanged();
}, 150);

await server.connect(new StdioServerTransport());

// Keeps the reference alive for the lint-free path; the module stays loaded by
// the transport's own handles either way.
void ToolListChangedNotificationSchema;
