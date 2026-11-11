import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = path.join(fixtures, "echo-mcp-server.mjs");
const gatewayFixture = path.join(fixtures, "gateway-mcp-server.mjs");

const context: PluginAgentConfigurationContext = {
  pluginMetadata: {},
  thread: { id: "t1", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "proj_a", kind: "standard" as const, name: "A", gitRemoteUrl: null },
  environment: {
    id: "e1", name: null, path: null,
    workspaceProvisionType: "unmanaged" as const, branchName: null,
  },
  host: { id: "h1", name: "local" },
  provider: {
    id: "codex", model: "m", capabilities: { supportsNativeUserQuestion: false },
  },
  origin: { kind: null, pluginId: null },
};

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

async function load(): Promise<ReturnType<typeof createFakePluginHost>> {
  host = createFakePluginHost({ pluginId: "mcp-hub" });
  await plugin(host.bb);
  return host;
}

async function addEcho(active: ReturnType<typeof createFakePluginHost>): Promise<void> {
  await active.harness.behavior.callRpc("servers_add", {
    displayName: "Echo", kind: "local" as const,
    command: process.execPath, args: [fixture],
  });
}

describe("agent surfaces", () => {
  it("registers nothing when no server is configured", async () => {
    const active = await load();
    const resolved = await active.harness.behavior.resolveAgentConfiguration(context);
    expect(resolved.tools).toEqual([]);
  });

  it("selects only tools bound to the thread's project", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "on",
    });

    const mine = await active.harness.behavior.resolveAgentConfiguration(context);
    expect(mine.tools.map((tool) => tool.name)).toEqual(["echo"]);

    const other = await active.harness.behavior.resolveAgentConfiguration({
      ...context, project: { ...context.project, id: "proj_b" },
    });
    expect(other.tools).toEqual([]);
  });

  it("gives a default-on tool to a project that never bound it", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("tools_set_default", {
      registeredNames: ["echo"], defaultEnabled: true,
    });
    // Neither project has a binding row, and nothing ever listed them: the
    // whole point of a default is that it reaches a project this plugin has
    // never heard of.
    for (const projectId of ["proj_a", "proj_b"]) {
      const resolved = await active.harness.behavior.resolveAgentConfiguration({
        ...context, project: { ...context.project, id: projectId },
      });
      expect(resolved.tools.map((tool) => tool.name)).toEqual(["echo"]);
    }
  });

  it("lets one project switch a default off without touching the others", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("tools_set_default", {
      registeredNames: ["echo"], defaultEnabled: true,
    });
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "off",
    });

    const off = await active.harness.behavior.resolveAgentConfiguration(context);
    expect(off.tools).toEqual([]);
    const other = await active.harness.behavior.resolveAgentConfiguration({
      ...context, project: { ...context.project, id: "proj_b" },
    });
    expect(other.tools.map((tool) => tool.name)).toEqual(["echo"]);

    // Back to inherit: the row goes, and the default applies again.
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "inherit",
    });
    const restored = await active.harness.behavior.resolveAgentConfiguration(context);
    expect(restored.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("tells an agent which of its tools are on by default", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    expect((await active.harness.behavior.runCli(["list"])).stdout).not.toContain("echo*");
    await active.harness.behavior.callRpc("tools_set_default", {
      registeredNames: ["echo"], defaultEnabled: true,
    });
    // An agent holding a tool no project bound has nowhere else to learn
    // where it came from.
    const listed = await active.harness.behavior.runCli(["list"]);
    expect(listed.stdout).toContain("echo*");
    expect(listed.stdout).toContain("on by default");
  });

  it("names what a gateway tool reaches, in the list and to the model", async () => {
    const active = await load();
    await active.harness.behavior.callRpc("servers_add", {
      displayName: "Gateway", kind: "local" as const,
      command: process.execPath, args: [gatewayFixture],
    });
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "gateway" });

    // The shell route: `execute` says nothing about Notion, and the panel and
    // the catalog show only the door.
    const listed = await active.harness.behavior.runCli(["list"]);
    expect(listed.stdout).toContain("execute reaches: notion_com, slack_com");

    // The model's route, for a provider that only ever matches whole words.
    const registered = active.harness.inspection.registrations.agentTools;
    expect(registered[0].description).toContain("Reaches: notion, slack.");
  });

  it("registers a newly synced tool without a reload", async () => {
    const active = await load();
    expect(active.harness.inspection.registrations.agentTools).toEqual([]);
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    const registered = active.harness.inspection.registrations.agentTools;
    expect(registered.map((tool) => tool.name)).toEqual(["echo"]);
    expect(registered[0].presentation?.label).toEqual({
      pending: "Running echo", completed: "Ran echo",
    });
  });

  it("drops a binding whose tool the model may not call", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "on",
    });
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "left-behind", state: "on",
    });
    // An unknown name rejects this plugin's WHOLE selection for the
    // resolution, so a binding left behind by a removed tool must never reach
    // configure() or it would silently disable every other MCP tool.
    const resolved = await active.harness.behavior.resolveAgentConfiguration(context);
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("restores a saved binding on the next load", async () => {
    // The bindings outlive the load that wrote them, but the snapshot they
    // feed is in memory, so a restart has to rebuild it from the table.
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", state: "on",
    });

    // Same settings, kv and database; a fresh in-memory selection.
    host = await active.harness.lifecycle.reload(plugin);
    const resolved = await host.harness.behavior.resolveAgentConfiguration(context);
    expect(resolved.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("keeps bindings for a project nothing ever listed", async () => {
    // No `sdk.projects.list` at all, and no waitFor: the snapshot is built
    // from the bindings table itself, so a project list that is short for any
    // reason can no longer decide whose tools survive a restart.
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    for (const projectId of ["proj_a", "proj_b"]) {
      await active.harness.behavior.callRpc("binding_set", {
        projectId, registeredName: "echo", state: "on",
      });
    }

    host = await active.harness.lifecycle.reload(plugin);
    const reloaded = host;
    for (const projectId of ["proj_a", "proj_b"]) {
      const resolved = await reloaded.harness.behavior.resolveAgentConfiguration({
        ...context, project: { ...context.project, id: projectId },
      });
      expect(resolved.tools.map((tool) => tool.name)).toEqual(["echo"]);
    }
  });

  it("never touches an MCP server on the load path", async () => {
    // The guarantee: registration reads the cached catalog, so a slow or
    // unreachable server can never delay a BB start. A server that writes a
    // marker file the moment it runs makes a spawn observable.
    const markerDir = mkdtempSync(path.join(tmpdir(), "bb-mcp-load-"));
    const marker = path.join(markerDir, "spawned");
    try {
      host = createFakePluginHost({ pluginId: "mcp-hub" });
      await plugin(host.bb);
      await host.harness.behavior.callRpc("servers_add", {
        displayName: "Marker", kind: "local" as const, command: process.execPath,
        args: ["-e", "require('fs').writeFileSync(process.env.MARKER, 'x')"],
        env: { MARKER: marker },
      });
      expect(existsSync(marker)).toBe(false);

      host = await host.harness.lifecycle.reload(plugin);
      expect(existsSync(marker)).toBe(false);
      // Nothing may spawn just after the load either, so let the event loop
      // run: the positive control below shows a spawn becomes visible in a
      // small fraction of this window.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(marker)).toBe(false);

      // Positive control: the sync path DOES spawn, so the marker is proof
      // the assertions above could have failed.
      const started = Date.now();
      const sync = host.harness.behavior
        .callRpc("catalog_sync", { serverId: "marker" })
        .catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      expect(Date.now() - started).toBeLessThan(250);
      await sync;
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  it("runs a registered tool against its MCP server", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    const result = await active.harness.behavior.callAgentTool("echo", { text: "hi" });
    expect(JSON.stringify(result)).toContain("hi");
  });

  it("returns an actionable error when the tool's server is gone", async () => {
    const active = await load();
    await addEcho(active);
    await active.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await active.harness.behavior.callRpc("servers_remove", { id: "echo" });
    const result = await active.harness.behavior.callAgentTool("echo", { text: "hi" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("echo");
  });
});
