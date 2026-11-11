// `bb mcp-hub` - the read-only view of what is configured.
//
// It exists for agents more than for people. BB renders a registered CLI
// command into the plugin-commands skill without executing plugin code, so an
// agent that wonders which MCP tools it has can answer the question from a
// shell instead of guessing from tool names. Everything that CHANGES a server
// stays in the panel: adding one means typing a command line or starting an
// OAuth flow, and neither belongs to an agent.
import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import type { Registry } from "../storage/registry.js";
import { gatewayIntegrations } from "./gateway.js";
import { driftedToolNames } from "./tools.js";

export interface CliDeps {
  registry: Registry;
}

function describe(bb: BbPluginApi, registry: Registry): string {
  const servers = registry.listServers();
  if (servers.length === 0) {
    return "No MCP servers are configured. Open the MCP panel in BB to add one.\n";
  }
  const lines: string[] = [];
  let anyDefault = false;
  let anyDrifted = false;
  for (const server of servers) {
    const target = server.transport === "stdio"
      ? [server.command, ...server.args].join(" ")
      : (server.url ?? "");
    const tools = registry.listTools(server.id);
    const live = tools.filter((tool) => !tool.stale);
    const drifted = driftedToolNames(bb, live);
    lines.push(
      `${server.id}  ${server.displayName}  [${server.kind}]`
      + `${server.enabled ? "" : " (disabled)"}`,
    );
    lines.push(`  ${target}`);
    // Above the tool list, not below it: an agent reading this to find out
    // why a call failed needs the reason before the inventory, and every tool
    // named underneath is unusable until someone reconnects the server.
    if (server.authError !== null) {
      lines.push(`  ! NEEDS RECONNECTING in the MCP panel: ${server.authError}`);
    }
    lines.push(
      live.length === 0
        ? "  no tools discovered yet - press Test in the MCP panel"
        : `  ${live.length} tool(s): `
          + live.map((tool) =>
            `${tool.registeredName}${tool.defaultEnabled ? "*" : ""}`
            + `${drifted.has(tool.registeredName) ? "!" : ""}`).join(", "),
    );
    // A gateway tool's name says nothing about what it reaches, and the
    // services behind it are named in its description and nowhere else. An
    // agent sent here to find out whether it can touch Notion has to be able
    // to read the answer off this list.
    for (const tool of live) {
      const integrations = gatewayIntegrations(tool.description);
      if (integrations.length > 0) {
        lines.push(`  ${tool.registeredName} reaches: ${integrations.join(", ")}`);
      }
    }
    anyDefault ||= live.some((tool) => tool.defaultEnabled);
    anyDrifted ||= drifted.size > 0;
  }
  // Without this an agent that finds itself holding a tool no project ever
  // bound has no way to learn where it came from.
  if (anyDefault) {
    lines.push("* on by default in every project that has not switched it off");
  }
  // An agent holding a tool whose description no longer matches the catalog
  // has no other way to find out, and the answer is never "sync again".
  if (anyDrifted) {
    lines.push(
      "! changed since it was registered - run `bb plugin reload mcp` to "
      + "update what the model is shown",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerCli(bb: BbPluginApi, deps: CliDeps): void {
  bb.cli.register({
    name: "mcp-hub",
    summary: "List the configured MCP servers and the tools they contribute.",
    commands: [
      { name: "list", summary: "List configured MCP servers and their tools.", usage: "bb mcp-hub list" },
    ],
    run(argv: string[]): PluginCliResult {
      // `bb mcp-hub` and `bb mcp-hub list` are the same thing; anything else is a
      // typo worth naming rather than silently treating as a list.
      const [command] = argv;
      if (command !== undefined && command !== "list") {
        return { exitCode: 1, stderr: `Unknown command "${command}". Usage: bb mcp-hub list\n` };
      }
      return { exitCode: 0, stdout: describe(bb, deps.registry) };
    },
  });
}
