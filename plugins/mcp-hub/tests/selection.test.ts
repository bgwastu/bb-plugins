import { describe, expect, it } from "vitest";
import { readOverrides, resolveSelection, TOOL_LIMIT } from "../src/server/selection.js";
import { discovered, memoryStore, serverRecord } from "./helpers.js";

describe("readOverrides", () => {
  it("reads boolean records and ignores everything else", () => {
    const overrides = readOverrides({
      servers: { a: false, b: "yes" },
      tools: { t: true },
    });
    expect(overrides).toEqual({ servers: { a: false }, tools: { t: true } });
  });

  it("survives metadata that is not an object", () => {
    expect(readOverrides({ servers: "nope", tools: [1, 2] })).toEqual({ servers: {}, tools: {} });
  });
});

describe("resolveSelection", () => {
  it("offers a new tool to a thread that never expressed an opinion", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, {});
    expect(selection.tools.map(({ tool }) => tool.name)).toEqual(["echo_echo"]);
  });

  it("lets a thread switch one tool off", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, { tools: { echo_echo: false } });
    expect(selection.tools).toEqual([]);
  });

  it("lets a thread switch a globally-off tool back on", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    store.setToolsEnabled(["echo_echo"], false);
    expect(resolveSelection(store, {}).tools).toEqual([]);
    expect(resolveSelection(store, { tools: { echo_echo: true } }).tools).toHaveLength(1);
  });

  it("keeps a disabled server's tools out even when a tool is switched on", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord({ enabled: false }));
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, { tools: { echo_echo: true } });
    expect(selection.tools).toEqual([]);
  });

  it("lets a thread switch a disabled server on", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord({ enabled: false }));
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, { servers: { echo: true } });
    expect(selection.tools).toHaveLength(1);
  });

  it("skips tools the server no longer advertises", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    store.syncTools("echo", [], 2);
    expect(resolveSelection(store, {}).tools).toEqual([]);
  });

  it("skips names BB refused to register", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, {}, new Set(["something-else"]));
    expect(selection.tools).toEqual([]);
    expect(selection.offered).toBe(0);
  });

  it("counts what did not fit and keeps the first tools", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    const tools = Array.from({ length: TOOL_LIMIT + 5 }, (_, index) => discovered({ name: `tool-${index}` }));
    store.syncTools("echo", tools, 1);
    const selection = resolveSelection(store, {});
    expect(selection.tools).toHaveLength(TOOL_LIMIT);
    expect(selection.offered).toBe(TOOL_LIMIT + 5);
    expect(selection.truncated).toBe(true);
  });
});
