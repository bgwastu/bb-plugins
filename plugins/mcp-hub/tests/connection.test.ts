import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionManager, type ConnectionManager } from "../src/mcp/connection.js";
import { createStdioSupervisor } from "../src/mcp/stdio.js";
import { createSecretStore, type SecretStore } from "../src/storage/secrets.js";
import { executeTool } from "../src/mcp/execute.js";
import { discovered, fixture, serverRecord } from "./helpers.js";

const managers: ConnectionManager[] = [];
const supervisors: Array<ReturnType<typeof createStdioSupervisor>> = [];

function build(options: { server?: Parameters<typeof serverRecord>[0]; secrets?: SecretStore } = {}) {
  const supervisor = createStdioSupervisor({
    resolvePath: async () => process.env.PATH ?? "",
    log: { warn: () => undefined },
  });
  supervisors.push(supervisor);
  const onToolsChanged = vi.fn();
  const connections = createConnectionManager({
    secrets: options.secrets ?? createSecretStore(null),
    stdio: supervisor,
    log: { warn: () => undefined },
    onToolsChanged,
  });
  managers.push(connections);
  const server = serverRecord({
    id: "raw",
    name: "Raw",
    args: [fixture("raw-mcp-server.mjs")],
    ...options.server,
  });
  return { connections, supervisor, onToolsChanged, server };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.killAll()));
});

describe("connection manager against a real stdio server", () => {
  it("discovers tools and maps annotations", async () => {
    const { connections, server } = build();
    const tools = await connections.discover(server);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("echo");
    expect(names).toContain("recursive");
    expect(connections.status("raw").state).toBe("ready");
    expect(connections.status("raw").toolCount).toBe(tools.length);
  }, 20_000);

  it("keeps the connection after the server refuses a call", async () => {
    const { connections, server } = build();
    const tools = await connections.discover(server);
    const fail = tools.find((tool) => tool.name === "fail");
    expect(fail).toBeDefined();

    const before = connections.client("raw");
    expect(before).not.toBeNull();

    const outcome = await executeTool(
      { connections },
      { server, tool: { ...toolRecordFor(fail!), readOnly: false }, arguments: {} },
    );
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.content[0]).toMatchObject({ type: "text" });
    expect(outcome.failure).toContain("the server says no");
    // The whole point: a protocol error is not a dead connection.
    expect(connections.client("raw")).toBe(before);

    const echo = tools.find((tool) => tool.name === "echo")!;
    const after = await executeTool(
      { connections },
      { server, tool: toolRecordFor(echo), arguments: { text: "still here" } },
    );
    expect(after.result).toEqual({ content: [{ type: "text", text: "still here" }], isError: false });
  }, 20_000);

  it("refuses a bad argument without calling the server", async () => {
    const { connections, server } = build();
    const tools = await connections.discover(server);
    const echo = tools.find((tool) => tool.name === "echo")!;
    await connections.discover(server);

    const outcome = await executeTool(
      { connections },
      { server, tool: toolRecordFor(echo), arguments: { text: 5 } },
    );
    expect(outcome.result.isError).toBe(true);
    expect(outcome.failure).toContain("arguments.text");
    expect(outcome.failure).toContain("not called");
  }, 20_000);

  it("keeps structure as well as text", async () => {
    const { connections, server } = build();
    const tools = await connections.discover(server);
    const structured = tools.find((tool) => tool.name === "structured")!;
    const outcome = await executeTool(
      { connections },
      { server, tool: toolRecordFor(structured), arguments: {} },
    );
    const text = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    expect(text).toContain("summary");
    expect(text).toContain('"count": 2');
  }, 20_000);

  it("reports the server's own isError result", async () => {
    const { connections, server } = build();
    const tools = await connections.discover(server);
    const returnsError = tools.find((tool) => tool.name === "returns-error")!;
    const outcome = await executeTool(
      { connections },
      { server, tool: toolRecordFor(returnsError), arguments: {} },
    );
    expect(outcome.result.isError).toBe(true);
    expect(outcome.failure).toBeNull();
  }, 20_000);

  it("hears tools/list_changed", async () => {
    const { connections, server, onToolsChanged } = build();
    await connections.discover(server);
    await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalledWith("raw"), { timeout: 4000 });
  }, 20_000);
});

describe("connection manager with a server that cannot start", () => {
  it("records the failure instead of throwing at load", async () => {
    const { connections, server } = build({ server: { args: [fixture("does-not-exist.mjs")] } });
    await expect(connections.discover(server)).rejects.toBeTruthy();
    expect(connections.status("raw").state).toBe("failed");
    expect(connections.status("raw").error).toBeTruthy();
  }, 20_000);
});

describe("connection manager with a secret", () => {
  it("passes configured env to the child", async () => {
    const secrets = createSecretStore(null);
    secrets.update("env-report", () => ({ env: { MCP_TEST_LEAK_MARKER: "yes" } }));
    const supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "",
      log: { warn: () => undefined },
    });
    supervisors.push(supervisor);
    const connections = createConnectionManager({
      secrets,
      stdio: supervisor,
      log: { warn: () => undefined },
      onToolsChanged: () => undefined,
    });
    managers.push(connections);

    // The env-report fixture prints its environment and exits, so the
    // handshake never completes - the stderr tail is what proves the env.
    const server = serverRecord({ id: "env-report", args: [fixture("env-report-mcp-server.mjs")] });
    await expect(connections.discover(server)).rejects.toBeTruthy();
    await vi.waitFor(() => expect(supervisor.stderrTail("env-report").join("\n")).toContain("HAS_LEAK=true"), {
      timeout: 4000,
    });
  }, 20_000);
});

function toolRecordFor(tool: ReturnType<typeof discovered>) {
  return {
    serverId: "raw",
    upstreamName: tool.name,
    name: `raw_${tool.name}`,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: tool.readOnly,
    enabled: true,
    missing: false,
    syncedAt: 1,
  };
}
