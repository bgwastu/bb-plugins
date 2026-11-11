// A gateway: one tool that reaches services named only in its description.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "gateway-fixture", version: "1.0.0" });
server.registerTool(
  "execute",
  {
    description: [
      "Execute TypeScript in a sandboxed runtime.",
      "",
      "## Available integrations",
      "",
      "- `notion_com`",
      "- `slack_com`",
    ].join("\n"),
    inputSchema: { code: z.string() },
  },
  async ({ code }) => ({ content: [{ type: "text", text: code }] }),
);
await server.connect(new StdioServerTransport());
