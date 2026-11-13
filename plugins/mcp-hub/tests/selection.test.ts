import { describe, expect, it } from "vitest";
import { resolveSelection, TOOL_LIMIT } from "../src/server/selection.js";
import { discovered, memoryStore, serverRecord } from "./helpers.js";

describe("resolveSelection", () => {
  it("offers an enabled server's tools", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    expect(resolveSelection(store).tools.map(({ tool }) => tool.name)).toEqual(["echo_echo"]);
  });

  it("drops a server that is switched off", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord({ enabled: false }));
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store);
    expect(selection.servers).toEqual([]);
    expect(selection.tools).toEqual([]);
  });

  it("drops a tool that is switched off", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    store.setToolsEnabled(["echo_echo"], false);
    expect(resolveSelection(store).tools).toEqual([]);
  });

  it("skips tools the server no longer advertises", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    store.syncTools("echo", [], 2);
    expect(resolveSelection(store).tools).toEqual([]);
  });

  it("skips names BB refused to register", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    const selection = resolveSelection(store, new Set(["something-else"]));
    expect(selection.tools).toEqual([]);
    expect(selection.offered).toBe(0);
  });

  it("counts what did not fit and keeps the first tools", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    const tools = Array.from({ length: TOOL_LIMIT + 5 }, (_, index) => discovered({ name: `tool-${index}` }));
    store.syncTools("echo", tools, 1);
    const selection = resolveSelection(store);
    expect(selection.tools).toHaveLength(TOOL_LIMIT);
    expect(selection.offered).toBe(TOOL_LIMIT + 5);
    expect(selection.truncated).toBe(true);
  });
});
