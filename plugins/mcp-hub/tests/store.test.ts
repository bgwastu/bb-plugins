import { describe, expect, it } from "vitest";
import { discovered, memoryStore, serverRecord } from "./helpers.js";

describe("store", () => {
  it("round-trips a server", () => {
    const { store } = memoryStore();
    const record = serverRecord({ args: ["--flag", "value"], cwd: "/tmp" });
    store.saveServer(record);
    expect(store.getServer(record.id)).toEqual(record);
  });

  it("updates a server without touching its creation time", () => {
    const { store } = memoryStore();
    const record = serverRecord();
    store.saveServer(record);
    store.saveServer({ ...record, name: "Renamed", enabled: false });
    const stored = store.getServer(record.id);
    expect(stored?.name).toBe("Renamed");
    expect(stored?.enabled).toBe(false);
    expect(stored?.createdAt).toBe(record.createdAt);
  });

  it("names a tool once and keeps that name across a rename upstream", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered({ name: "echo" })], 1);
    const first = store.listTools("echo")[0];
    expect(first.name).toBe("echo_echo");

    store.syncTools("echo", [discovered({ name: "echo", description: "changed" })], 2);
    const second = store.listTools("echo")[0];
    expect(second.name).toBe(first.name);
    expect(second.description).toBe("changed");
  });

  it("marks a tool the server no longer advertises as missing, not gone", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered({ name: "a" }), discovered({ name: "b" })], 1);
    const changed = store.syncTools("echo", [discovered({ name: "a" })], 2);
    expect(changed).toBe(true);
    const tools = store.listTools("echo");
    expect(tools.map((tool) => tool.upstreamName).sort()).toEqual(["a", "b"]);
    expect(tools.find((tool) => tool.upstreamName === "b")?.missing).toBe(true);
  });

  it("reports no change when nothing moved", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    expect(store.syncTools("echo", [discovered()], 2)).toBe(false);
  });

  it("never gives two servers the same registered name", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord({ id: "one", name: "One" }));
    store.saveServer(serverRecord({ id: "two", name: "Two" }));
    store.syncTools("one", [discovered({ name: "search" })], 1);
    store.syncTools("two", [discovered({ name: "search" })], 1);
    const names = store.listTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(2);
  });

  it("keeps new tools on by default", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    expect(store.listTools("echo")[0].enabled).toBe(true);
  });

  it("removes a server's tools and call log with it", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    store.syncTools("echo", [discovered()], 1);
    store.recordCall({ at: 1, serverId: "echo", tool: "echo", threadId: null, ok: true, durationMs: 1, error: null });
    store.removeServer("echo");
    expect(store.listServers()).toEqual([]);
    expect(store.listTools()).toEqual([]);
    expect(store.listCalls("echo", 10)).toEqual([]);
  });

  it("bounds the call log per server", () => {
    const { store } = memoryStore();
    store.saveServer(serverRecord());
    for (let index = 0; index < 205; index += 1) {
      store.recordCall({
        at: index,
        serverId: "echo",
        tool: "echo",
        threadId: null,
        ok: true,
        durationMs: 1,
        error: null,
      });
    }
    const calls = store.listCalls("echo", 500);
    expect(calls.length).toBe(200);
    expect(calls[0].at).toBe(204);
  });
});
