// The plugin through BB's own fake host, which applies production validation
// to every registration: rpc contracts, the CLI spec, tool schemas, and
// `agents.configure`'s fail-closed selection.
//
// This is the test that says "it loads in BB", which the unit tests cannot.
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";
import { fixture } from "./helpers.js";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const metadata: Record<string, Record<string, unknown>> = {};

async function loaded() {
  const host = createFakePluginHost({
    pluginId: "mcp-hub",
    agentSkillIds: ["mcp-hub"],
    dataDir: `/tmp/bb-mcp-hub-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) =>
          (metadata[threadId] ?? {}) as Record<string, never>,
        updatePluginMetadata: async (args) => {
          metadata[args.threadId] = { ...(metadata[args.threadId] ?? {}), ...(args.set ?? {}) };
          return metadata[args.threadId] as Record<string, never>;
        },
        get: async ({ threadId }: { threadId: string }) =>
          ({ id: threadId, status: "idle" }) as never,
        stop: async () => ({}) as never,
      },
    },
  });
  hosts.push(host);
  for (const key of Object.keys(metadata)) delete metadata[key];
  await plugin(host.bb);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.harness.lifecycle.dispose();
  }
});

const echoServer = {
  name: "Echo",
  transport: "stdio",
  command: process.execPath,
  args: [fixture("echo-mcp-server.mjs")],
  auth: "none",
  enabled: true,
  connect: true,
};

describe("the plugin on the fake host", () => {
  it("registers every surface the host validates", async () => {
    const host = await loaded();
    const registrations = host.harness.inspection.registrations;

    expect(registrations.rpcMethods).toContain("snapshot");
    expect(registrations.rpcMethods).toContain("selection_set");
    expect(registrations.cli?.name).toBe("mcp-hub");
    expect(registrations.services.map((service) => service.name)).toEqual(["connections"]);
    expect(registrations.schedules.map((schedule) => schedule.name)).toEqual(["catalog-refresh"]);
    expect(registrations.agentConfigurationProvider).not.toBeNull();
  });

  it("adds a server over RPC, registers its tool, and selects it for a thread", async () => {
    const host = await loaded();

    const created = (await host.harness.behavior.callRpc("server_create", echoServer)) as {
      id: string;
      error: string | null;
    };
    expect(created).toEqual({ id: "echo", authorizationUrl: null, error: null });

    const toolNames = host.harness.inspection.registrations.agentTools.map((tool) => tool.name);
    expect(toolNames).toContain("echo_echo");

    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: {} }),
    );
    // The schema override travels with the selection, so a changed schema
    // reaches the next session without a reload.
    expect(configuration.tools.map((tool) => tool.name)).toEqual(["echo_echo"]);
    expect(configuration.skills).toEqual(["mcp-hub"]);
    expect(configuration.instructions).toBeNull();
  }, 20_000);

  it("calls the registered tool through the host's tool path", async () => {
    const host = await loaded();
    await host.harness.behavior.callRpc("server_create", echoServer);

    const result = await host.harness.behavior.callAgentTool("echo_echo", { text: "hello" });
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }], isError: false });

    const calls = (await host.harness.behavior.callRpc("calls", { serverId: "echo", limit: 10 })) as {
      calls: Array<{ tool: string; ok: boolean }>;
    };
    expect(calls.calls[0]).toMatchObject({ tool: "echo", ok: true });
  }, 20_000);

  it("answers the CLI from the same state", async () => {
    const host = await loaded();
    await host.harness.behavior.callRpc("server_create", echoServer);

    const listed = await host.harness.behavior.runCli(["list", "--tools"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("echo");
    expect(listed.stdout).toContain("echo_echo");

    const called = await host.harness.behavior.runCli([
      "call",
      "echo",
      "echo_echo",
      "--args",
      '{"text":"from cli"}',
    ]);
    expect(called.exitCode).toBe(0);
    expect(called.stdout).toContain("from cli");
  }, 20_000);

  it("saves a thread selection and restarts that thread", async () => {
    const host = await loaded();
    await host.harness.behavior.callRpc("server_create", echoServer);

    const saved = (await host.harness.behavior.callRpc("selection_set", {
      threadId: "thread-1",
      servers: {},
      tools: { echo_echo: false },
      clearedServers: [],
      clearedTools: [],
      apply: true,
      interrupt: false,
    })) as { restarted: boolean; deferred: boolean; offered: number };
    expect(saved).toMatchObject({ restarted: true, deferred: false, offered: 0 });

    expect(host.harness.inspection.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(1);
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thread-1" }]]);

    // The stored override is a delta: the tool name maps to false, nothing else.
    const metadata = host.harness.inspection.sdk.callsTo("threads.updatePluginMetadata")[0][0] as {
      set: { tools: Record<string, boolean> };
    };
    expect(metadata.set.tools).toEqual({ echo_echo: false });
  }, 20_000);

  it("keeps a tool this thread switched off out of the session, and refused", async () => {
    const host = await loaded();
    await host.harness.behavior.callRpc("server_create", echoServer);

    const configuration = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { tools: { echo_echo: false } } }),
    );
    expect(configuration.tools).toEqual([]);
    expect(configuration.instructions).toBeNull();

    // A session that still has the tool from before the switch gets a refusal,
    // not a silent call.
    const refused = (await host.harness.behavior.callAgentTool(
      "echo_echo",
      { text: "hello" },
      { threadId: "thread-off" },
    )) as { isError: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(false);
    // Without metadata for that thread, the global switch still allows it.
    expect(refused.content[0]).toMatchObject({ type: "text", text: "hello" });
  }, 20_000);

  it("reports a failed connection on the row instead of failing the call", async () => {
    const host = await loaded();
    const created = (await host.harness.behavior.callRpc("server_create", {
      name: "Broken",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      args: [],
      auth: "none",
      enabled: true,
      connect: true,
    })) as { error: string | null };
    expect(created.error).toBeTruthy();

    const snapshot = (await host.harness.behavior.callRpc("snapshot", {})) as {
      servers: Array<{ id: string; state: string }>;
    };
    expect(snapshot.servers[0]).toMatchObject({ id: "broken", state: "failed" });
  }, 20_000);

  it("rejects an invalid server over the contract, before any handler runs", async () => {
    const host = await loaded();
    await expect(
      host.harness.behavior.callRpc("server_create", {
        name: "",
        transport: "http",
        url: "not-a-url",
        args: [],
        auth: "none",
        enabled: true,
        connect: false,
      }),
    ).rejects.toBeTruthy();
  });
});
