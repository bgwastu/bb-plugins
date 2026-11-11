import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createCatalog } from "../src/catalog.js";
import type { ClientPool, DiscoveredTool } from "../src/mcp/client-pool.js";
import { createRegistry, type Registry } from "../src/storage/registry.js";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";

function registry(): Registry {
  const handle = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) handle.exec(statement);
  return createRegistry(handle);
}

function addServer(store: Registry, id: string): void {
  store.upsertServer({
    id, displayName: id, transport: "http", kind: "remote" as const,
        url: `https://${id}.test/mcp`,
    command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  });
}

const log = { warn: vi.fn(), info: vi.fn() };

/** A pool whose `listTools` answer is scripted per server id. */
function fakePool(answers: Record<string, DiscoveredTool[] | Error>): ClientPool {
  return {
    async listTools(server) {
      const answer = answers[server.id];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async callTool() {
      throw new Error("not used");
    },
    async close() {},
    async closeAll() {},
  };
}

function tool(name: string, readOnly = false): DiscoveredTool {
  return { name, description: `${name} does things`, inputSchema: { type: "object" }, readOnly };
}

describe("catalog", () => {
  it("persists a resolved name and reuses it on the next sync", async () => {
    const store = registry();
    addServer(store, "notion");
    const catalog = createCatalog({
      registry: store, pool: fakePool({ notion: [tool("search")] }), log,
    });
    expect(await catalog.sync("notion")).toEqual(["search"]);
    expect(await catalog.sync("notion")).toEqual([]);
    expect(store.listTools("notion").map((row) => row.registeredName)).toEqual(["search"]);
  });

  it("prefixes a name a second server already took", async () => {
    const store = registry();
    addServer(store, "notion");
    addServer(store, "linear");
    const catalog = createCatalog({
      registry: store,
      pool: fakePool({ notion: [tool("search")], linear: [tool("search")] }),
      log,
    });
    await catalog.sync("notion");
    expect(await catalog.sync("linear")).toEqual(["linear_search"]);
  });

  it("defaults ask from readOnly and keeps a later override", async () => {
    const store = registry();
    addServer(store, "notion");
    const catalog = createCatalog({
      registry: store,
      pool: fakePool({ notion: [tool("search", true), tool("write", false)] }),
      log,
    });
    await catalog.sync("notion");
    expect(store.listTools("notion").map((row) => row.ask)).toEqual([false, true]);
    store.setToolAsk("notion", "write", false);
    await catalog.sync("notion");
    expect(store.getToolByRegisteredName("write")?.ask).toBe(false);
  });

  it("keeps a user-set default through a sync", async () => {
    const store = registry();
    addServer(store, "notion");
    const catalog = createCatalog({
      registry: store, pool: fakePool({ notion: [tool("search", true)] }), log,
    });
    await catalog.sync("notion");
    store.setToolDefaults([{ serverId: "notion", upstreamName: "search" }], true);
    await catalog.sync("notion");
    // A sync that dropped this would switch the tool off in every project at
    // once - the same drift the ask flag suffered before migration 8.
    expect(store.getToolByRegisteredName("search")?.defaultEnabled).toBe(true);
  });

  it("marks a vanished tool stale instead of deleting it", async () => {
    const store = registry();
    addServer(store, "notion");
    const answers: Record<string, DiscoveredTool[]> = { notion: [tool("search"), tool("gone")] };
    const catalog = createCatalog({ registry: store, pool: fakePool(answers), log });
    await catalog.sync("notion");
    answers.notion = [tool("search")];
    await catalog.sync("notion");
    expect(store.getToolByRegisteredName("gone")).toMatchObject({ stale: true });
  });

  it("leaves the catalog untouched when tools/list fails", async () => {
    const store = registry();
    addServer(store, "notion");
    const answers: Record<string, DiscoveredTool[] | Error> = { notion: [tool("search")] };
    const catalog = createCatalog({ registry: store, pool: fakePool(answers), log });
    await catalog.sync("notion");
    answers.notion = new Error("connection refused");
    await expect(catalog.sync("notion")).rejects.toThrow(/connection refused/);
    expect(store.listTools("notion")).toMatchObject([{ registeredName: "search", stale: false }]);
  });

  it("refuses to sync a server that is not configured", async () => {
    const catalog = createCatalog({ registry: registry(), pool: fakePool({}), log });
    await expect(catalog.sync("ghost")).rejects.toThrow(/ghost/);
  });

  it("keeps syncing the other servers when one fails", async () => {
    const store = registry();
    addServer(store, "broken");
    addServer(store, "notion");
    const catalog = createCatalog({
      registry: store,
      pool: fakePool({ broken: new Error("nope"), notion: [tool("search")] }),
      log,
    });
    await catalog.syncAll();
    expect(store.getToolByRegisteredName("search")).toBeDefined();
  });

  it("skips a disabled server in syncAll", async () => {
    const store = registry();
    addServer(store, "notion");
    const server = store.getServer("notion")!;
    store.upsertServer({ ...server, enabled: false });
    const catalog = createCatalog({
      registry: store, pool: fakePool({ notion: [tool("search")] }), log,
    });
    await catalog.syncAll();
    expect(store.listTools("notion")).toEqual([]);
  });
});

/**
 * `ask` is the only thing standing between a model and a write, and it is
 * derived from an annotation the SERVER controls. These pin the two halves of
 * that: a derived default has to follow the annotation it was derived from,
 * and a choice the user made explicitly has to survive one.
 */
describe("catalog ask policy", () => {
  function askOf(store: Registry, name: string): boolean | undefined {
    return store.getToolByRegisteredName(name)?.ask;
  }

  it("re-derives ask when the server flips a tool from read-only to a write", async () => {
    const store = registry();
    addServer(store, "notion");
    const answers: Record<string, DiscoveredTool[]> = {
      notion: [tool("send_message", true)],
    };
    const catalog = createCatalog({ registry: store, pool: fakePool(answers), log });
    await catalog.sync("notion");
    expect(askOf(store, "send_message")).toBe(false);

    // The server corrects the annotation - or a malicious one flips it after
    // the user bound the tool. Either way it is a write now.
    answers.notion = [tool("send_message", false)];
    await catalog.sync("notion");
    expect(askOf(store, "send_message")).toBe(true);
  });

  it("keeps an explicit choice when the annotation flips under it", async () => {
    const store = registry();
    addServer(store, "notion");
    const answers: Record<string, DiscoveredTool[]> = { notion: [tool("write", false)] };
    const catalog = createCatalog({ registry: store, pool: fakePool(answers), log });
    await catalog.sync("notion");
    store.setToolAsk("notion", "write", false);

    answers.notion = [tool("write", true)];
    await catalog.sync("notion");
    answers.notion = [tool("write", false)];
    await catalog.sync("notion");
    // The user said "never ask for this one". Only the user takes that back.
    expect(askOf(store, "write")).toBe(false);
  });

  it("forces ask on for a Google server whatever readOnlyHint claims", async () => {
    const store = registry();
    store.upsertServer({
      id: "gmail", displayName: "Gmail", transport: "http", kind: "remote" as const,
      url: "https://mcp.googleapis.com/mcp", command: null, args: [], env: {}, headers: {},
      cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    const catalog = createCatalog({
      registry: store, pool: fakePool({ gmail: [tool("search_mail", true)] }), log,
    });
    await catalog.sync("gmail");
    // Design section 12.1: reading an attacker-authored mail IS the attack, so
    // a read annotation buys a Gmail tool nothing.
    expect(askOf(store, "search_mail")).toBe(true);

    store.setToolAsk("gmail", "search_mail", false);
    await catalog.sync("gmail");
    expect(askOf(store, "search_mail")).toBe(true);
  });
});
