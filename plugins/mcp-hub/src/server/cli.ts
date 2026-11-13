// `bb mcp-hub` - what a shell can ask about the same state the panel shows.
import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "../storage/store.js";
import type { Hub } from "./hub.js";
import type { ConnectionManager } from "../mcp/connection.js";

export interface CliDeps {
  store: Store;
  connections: ConnectionManager;
  hub: Hub;
}

function stateWord(state: string): string {
  switch (state) {
    case "ready":
      return "connected";
    case "needs-auth":
      return "sign-in needed";
    case "failed":
      return "error";
    case "connecting":
      return "connecting";
    default:
      return "not connected";
  }
}

export function registerCli(bb: BbPluginApi, deps: CliDeps): void {
  const list = cliCommand({
    summary: "List configured MCP servers and their tools",
    options: {
      tools: { type: "boolean", description: "Include each server's tools" },
    },
    run: ({ options }) => {
      const servers = deps.store.listServers();
      if (servers.length === 0) {
        return { exitCode: 0, stdout: "No MCP servers configured.\n" };
      }
      const lines: string[] = [];
      for (const server of servers) {
        const status = deps.connections.status(server.id);
        const tools = deps.store.listTools(server.id).filter((tool) => !tool.missing);
        const enabledTools = tools.filter((tool) => tool.enabled && server.enabled);
        const target = server.transport === "stdio" ? (server.command ?? "") : (server.url ?? "");
        lines.push(
          `${server.id}  ${stateWord(status.state)}  ${enabledTools.length}/${tools.length} tools  ${target}`,
        );
        if (status.error) lines.push(`  error: ${status.error}`);
        if (server.enabled === false) lines.push("  turned off in the MCP settings");
        if (options.tools) {
          for (const tool of tools) {
            const flag = tool.enabled && server.enabled ? "on " : "off";
            lines.push(`  [${flag}] ${tool.name}  ${tool.title ?? tool.upstreamName}`);
          }
        }
      }
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });

  const sync = cliCommand({
    summary: "Reconnect and reread one server's tool list",
    positionals: [{ name: "server", description: "Server id", required: true }],
    run: async ({ positionals }) => {
      try {
        const result = await deps.hub.syncById(positionals.server);
        return {
          exitCode: 0,
          stdout: `${positionals.server}: ${result.tools} tools (${result.added.length} new)\n`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        };
      }
    },
  });

  const test = cliCommand({
    summary: "Connect to a server and report what it answers",
    positionals: [{ name: "server", description: "Server id", required: true }],
    run: async ({ positionals }) => {
      const server = deps.store.getServer(positionals.server);
      if (!server) return { exitCode: 1, stderr: `No server "${positionals.server}".\n` };
      try {
        const tools = await deps.connections.discover(server);
        const names = tools.map((tool) => `  ${tool.name}`).join("\n");
        return { exitCode: 0, stdout: `connected: ${tools.length} tools\n${names}\n` };
      } catch (error) {
        const status = deps.connections.status(server.id);
        const message = error instanceof Error ? error.message : String(error);
        return {
          exitCode: 1,
          stderr: `${message}\n${status.authorizationUrl ? `sign in: ${status.authorizationUrl}\n` : ""}`,
        };
      }
    },
  });

  const call = cliCommand({
    summary: "Call a tool on a server",
    positionals: [
      { name: "server", description: "Server id", required: true },
      { name: "tool", description: "Tool name, as the model sees it", required: true },
    ],
    options: {
      args: { type: "string", description: "JSON object of arguments", default: "{}" },
    },
    run: async ({ positionals, options }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(options.args);
      } catch {
        return { exitCode: 1, stderr: "--args must be a JSON object.\n" };
      }
      const outcome = await deps.hub.runTool({
        serverId: positionals.server,
        tool: positionals.tool,
        arguments: parsed,
      });
      const text = outcome.result.content
        .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
        .join("\n");
      return {
        exitCode: outcome.result.isError ? 1 : 0,
        stdout: `${text}\n`,
        ...(outcome.failure ? { stderr: `${outcome.failure}\n` } : {}),
      };
    },
  });

  bb.cli.register(
    defineCli({
      name: "mcp-hub",
      summary: "MCP servers connected through the MCP Hub plugin",
      root: list,
      commands: { list, sync, test, call },
    }),
  );
}
