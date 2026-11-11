// What an agent is told about a gateway without anyone writing it down.
//
// A gateway contributes a few tools that reach a much larger set the catalog
// never sees, and the services behind it are named only inside one tool's
// description - which a provider may never put in front of the model. Claude
// Code lists a plugin tool by name and loads its description on a keyword
// search that matches whole words, so an agent asked about Notion searches,
// finds nothing, and reports that nothing offers Notion while `execute` sits
// in its own tool list.
import { describe, expect, it } from "vitest";
import { buildInstructions, MAX_INSTRUCTIONS } from "../src/server/configure.js";
import type { CatalogTool } from "../src/storage/registry.js";

function tool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    serverId: "executor", upstreamName: "execute", registeredName: "execute",
    description: "Run code.\n\n## Available integrations\n- `notion_com`\n- `slack_com`\n",
    inputSchema: {}, readOnly: false, defaultEnabled: true, stale: false, syncedAt: 1, ...overrides,
  };
}

describe("gateway instructions", () => {
  it("names the services behind a gateway as words", () => {
    const text = buildInstructions([tool()]);
    expect(text).toContain("notion");
    expect(text).toContain("slack");
    expect(text).toContain("execute");
  });

  it("tells the agent to load the tool by exact name", () => {
    // The load-bearing sentence: a keyword search for "notion" is not a hit
    // for a tool called `execute`, so searching is not how this gets found.
    expect(buildInstructions([tool()])).toContain("select:mcp__bb-bridge__execute");
  });

  it("says nothing when no gateway is configured", () => {
    // An ordinary MCP server needs no explaining, and instructions cost every
    // turn of every thread.
    expect(buildInstructions([tool({ description: "Search Notion pages." })])).toBe("");
  });

  it("ignores a stale row", () => {
    expect(buildInstructions([tool({ stale: true })])).toBe("");
  });

  it("stays inside the host's truncation limit", () => {
    const many = Array.from({ length: 40 }, (_, index) => tool({
      registeredName: `tool_${index}`,
      upstreamName: `tool_${index}`,
      description: `Run code.\n${Array.from({ length: 40 }, (_, n) =>
        `- \`service_${index}_${n}_com\``).join("\n")}\n`,
    }));
    expect(buildInstructions(many).length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
  });
});
