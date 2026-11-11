// The load/dispose/reload contract, exercised against the real `server.ts`.
//
// These are the only tests that run the whole plugin twice against one
// database. A reload is what BB does on every `bb plugin reload` and on every
// edit in development, and the two ways it can go wrong - state that does not
// survive it, and children that do - are invisible to every per-module test.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { rpcContract } from "../contract.js";
import plugin from "../server.js";

type ServersList = z.infer<(typeof rpcContract)["servers_list"]["output"]>;

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

async function load(): Promise<ReturnType<typeof createFakePluginHost>> {
  host = createFakePluginHost({ pluginId: "mcp-hub" });
  await plugin(host.bb);
  return host;
}

describe("lifecycle", () => {
  it("loads with no servers and disposes cleanly", async () => {
    const loaded = await load();
    await expect(loaded.harness.lifecycle.dispose()).resolves.not.toThrow();
    host = null;
  });

  it("survives a reload against the same database", async () => {
    const loaded = await load();
    await loaded.harness.behavior.callRpc("servers_add", {
      displayName: "Echo",
      kind: "local",
      command: process.execPath,
      args: [fixture],
    });

    const reloaded = await loaded.harness.lifecycle.reload(plugin);
    host = reloaded;
    const listed = await reloaded.harness.behavior.callRpc("servers_list", null) as ServersList;
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0]?.displayName).toBe("Echo");
  });

  it("registers a catalog refresh that runs with no servers configured", async () => {
    const loaded = await load();
    await expect(loaded.harness.behavior.runSchedule("catalog-refresh")).resolves.not.toThrow();
  });

  it("lists configured servers over the CLI", async () => {
    const loaded = await load();
    await loaded.harness.behavior.callRpc("servers_add", {
      displayName: "Echo",
      kind: "local",
      command: process.execPath,
      args: [fixture],
    });

    const result = await loaded.harness.behavior.runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Echo");
    // The connection type, not the transport: it is the word the panel uses
    // and the one the user chose.
    expect(result.stdout).toContain("local");
  });
});
