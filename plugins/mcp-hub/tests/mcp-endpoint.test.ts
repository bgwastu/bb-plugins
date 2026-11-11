import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

type Host = ReturnType<typeof createFakePluginHost>;

async function load(): Promise<Host> {
  host = createFakePluginHost({ pluginId: "mcp-hub" });
  await plugin(host.bb);
  await host.harness.behavior.callRpc("servers_add", {
    displayName: "Echo", kind: "local", command: process.execPath, args: [fixture],
  });
  await host.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
  return host;
}

async function rpc(active: Host, method: string, params?: unknown): Promise<any> {
  const response = await active.harness.behavior.fetchHttp("POST", "/mcp", {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  } as never);
  return response.json();
}

const allow = async (active: Host): Promise<void> => {
  await active.harness.behavior.callRpc("tool_set_ask", {
    serverId: "echo", upstreamName: "echo", ask: false,
  });
  await active.harness.behavior.callRpc("tools_set_default", {
    registeredNames: ["echo"], defaultEnabled: true,
  });
};

describe("mcp endpoint", () => {
  it("is mounted behind the plugin token, not the open local origin", async () => {
    const active = await load();
    const routes = active.harness.inspection.registrations.httpRoutes
      .filter((route) => route.path === "/mcp");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route.auth).toBe("token");
  });

  it("leaves out a tool that asks, since no thread exists to prompt in", async () => {
    const active = await load();
    await active.harness.behavior.callRpc("tools_set_default", {
      registeredNames: ["echo"], defaultEnabled: true,
    });
    const listed = await rpc(active, "tools/list");
    expect(listed.result.tools).toEqual([]);
    const called = await rpc(active, "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(called.result.isError).toBe(true);
  });

  it("lists and runs a tool that does not ask", async () => {
    const active = await load();
    await allow(active);
    const listed = await rpc(active, "tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo"]);
    const called = await rpc(active, "tools/call", { name: "echo", arguments: { text: "hello" } });
    expect(called.result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("goes quiet when the server is switched off", async () => {
    const active = await load();
    await allow(active);
    await active.harness.behavior.callRpc("servers_set_enabled", { id: "echo", enabled: false });
    expect((await rpc(active, "tools/list")).result.tools).toEqual([]);
  });
});
