import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { createToolSurfaces } from "../src/server/tools.js";
import type { ExecuteOutcome } from "../src/mcp/execute.js";
import { discovered, memoryStore, serverRecord } from "./helpers.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: unknown, ctx: { threadId: string }) => Promise<unknown>;
}

function fakeBb() {
  const tools = new Map<string, RegisteredTool>();
  const bb = {
    agents: {
      registerTool: (tool: RegisteredTool) => {
        if (tools.has(tool.name)) throw new Error(`${tool.name} is already registered`);
        tools.set(tool.name, tool);
      },
    },
  } as unknown as BbPluginApi;
  return { bb, tools };
}

function outcome(text: string, isError = false): ExecuteOutcome {
  return {
    result: { content: [{ type: "text", text }], isError },
    durationMs: 1,
    failure: isError ? text : null,
    needsAuth: false,
  };
}

describe("tool surfaces", () => {
  it("registers every cached tool from the cache alone", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered({ name: "one" }), discovered({ name: "two" })], 1);
    const { bb, tools } = fakeBb();
    const surfaces = createToolSurfaces(bb, {
      store,
      execute: async () => outcome("never called"),
      log: { warn: () => undefined },
    });

    expect(surfaces.register().sort()).toEqual(["echo_one", "echo_two"]);
    expect(tools.has("echo_one")).toBe(true);
    expect(tools.get("echo_one")?.description).toContain('From the MCP server "Echo"');
  });

  it("does not register the same tool twice", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const { bb } = fakeBb();
    const surfaces = createToolSurfaces(bb, {
      store,
      execute: async () => outcome("never called"),
      log: { warn: () => undefined },
    });
    expect(surfaces.register()).toHaveLength(1);
    expect(surfaces.register()).toEqual([]);
  });

  it("skips a recursive schema and says why", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools(
      "echo",
      [
        discovered({ name: "ok" }),
        discovered({
          name: "recursive",
          inputSchema: {
            type: "object",
            properties: { node: { $ref: "#/definitions/node" } },
            definitions: { node: { type: "object", properties: { child: { $ref: "#/definitions/node" } } } },
          },
        }),
      ],
      1,
    );
    const { bb, tools } = fakeBb();
    const surfaces = createToolSurfaces(bb, {
      store,
      execute: async () => outcome("never called"),
      log: { warn: () => undefined },
    });
    expect(surfaces.register()).toEqual(["echo_ok"]);
    expect(tools.has("echo_recursive")).toBe(false);
    expect(surfaces.problem("echo_recursive")).toContain("recursive");
  });

  it("records what BB refused to register instead of failing the load", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const bb = {
      agents: {
        registerTool: () => {
          throw new Error("that name belongs to another plugin");
        },
      },
    } as unknown as BbPluginApi;
    const surfaces = createToolSurfaces(bb, {
      store,
      execute: async () => outcome("never called"),
      log: { warn: () => undefined },
    });
    expect(surfaces.register()).toEqual([]);
    expect(surfaces.problem("echo_echo")).toContain("another plugin");
  });

  it("calls the executor with the model's arguments", async () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const { bb, tools } = fakeBb();
    const execute = vi.fn(async () => outcome("hi"));
    const surfaces = createToolSurfaces(bb, { store, execute, log: { warn: () => undefined } });
    surfaces.register();

    const result = await tools.get("echo_echo")!.execute({ text: "hi" }, { threadId: "t1" });
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { text: "hi" }, threadId: "t1" }),
    );
  });

  it("refuses a tool whose server was switched off after it was registered", async () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const { bb, tools } = fakeBb();
    const execute = vi.fn(async () => outcome("hi"));
    const surfaces = createToolSurfaces(bb, { store, execute, log: { warn: () => undefined } });
    surfaces.register();

    store.setServerEnabled("echo", false);
    const result = (await tools.get("echo_echo")!.execute({ text: "hi" }, { threadId: "t1" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("turned off");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tool switched off after it was registered", async () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const { bb, tools } = fakeBb();
    const execute = vi.fn(async () => outcome("hi"));
    const surfaces = createToolSurfaces(bb, { store, execute, log: { warn: () => undefined } });
    surfaces.register();

    store.setToolsEnabled(["echo_echo"], false);
    const result = (await tools.get("echo_echo")!.execute({ text: "hi" }, { threadId: "t1" })) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows the call again once the switch comes back on", async () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const { bb, tools } = fakeBb();
    const execute = vi.fn(async () => outcome("hi"));
    const surfaces = createToolSurfaces(bb, { store, execute, log: { warn: () => undefined } });
    surfaces.register();

    store.setServerEnabled("echo", false);
    await tools.get("echo_echo")!.execute({ text: "hi" }, { threadId: "t1" });
    expect(execute).not.toHaveBeenCalled();

    store.setServerEnabled("echo", true);
    const result = (await tools.get("echo_echo")!.execute({ text: "hi" }, { threadId: "t1" })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
