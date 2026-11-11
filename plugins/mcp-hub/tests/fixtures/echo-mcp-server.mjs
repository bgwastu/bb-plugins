import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

process.stderr.write(`fixture starting pid=${process.pid}\n`);
const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
await server.connect(new StdioServerTransport());
