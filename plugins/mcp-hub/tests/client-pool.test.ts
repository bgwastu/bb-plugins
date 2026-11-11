// tests/client-pool.test.ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClientPool } from "../src/mcp/client-pool.js";
import type { ServerRecord } from "../src/storage/registry.js";

const server: ServerRecord = {
  id: "fake", displayName: "Fake", transport: "http", kind: "remote" as const, url: "https://x/mcp",
  command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
  oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
  authError: null, authErrorAt: null,
};

function fakeUpstream() {
  const mcp = new McpServer({ name: "fake", version: "1.0.0" });
  mcp.registerTool("echo", {
    description: "Echo text",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  return mcp;
}

function pool() {
  return createClientPool({
    async createTransport() {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await fakeUpstream().connect(serverSide);
      return clientSide;
    },
    log: { warn: vi.fn(), info: vi.fn() },
  });
}

describe("client pool", () => {
  it("lists tools with their readOnly annotation", async () => {
    const tools = await pool().listTools(server);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "echo", readOnly: true });
    expect(tools[0].inputSchema.type).toBe("object");
  });

  it("calls a tool and translates its content", async () => {
    const result = await pool().callTool(server, "echo", { text: "hello" }, {
      signal: new AbortController().signal, timeoutMs: 5_000,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("reports the status of a handshake that failed over HTTP", async () => {
    // The `initialize` POST is where a URL missing its /mcp path shows up, and
    // it fails before the pool has a client to catch a failure on.
    const rooted = { ...server, url: "https://x/" };
    const failing = createClientPool({
      async createTransport() {
        return {
          async start() {
            throw Object.assign(
              new Error("Streamable HTTP error: Error POSTing to endpoint: "),
              { code: 405 },
            );
          },
          async send() {},
          async close() {},
        };
      },
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await expect(failing.listTools(rooted)).rejects.toThrow(/HTTP 405.*\/mcp/s);
  });

  it("reuses one client across calls", async () => {
    const createTransport = vi.fn(async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await fakeUpstream().connect(serverSide);
      return clientSide;
    });
    const shared = createClientPool({ createTransport, log: { warn: vi.fn(), info: vi.fn() } });
    await shared.listTools(server);
    await shared.listTools(server);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });
});

/**
 * The pool is process-wide, so anything that drops a client drops it for every
 * thread. These pin what may and may not do that.
 */
describe("client pool resilience", () => {
  function slowUpstream() {
    const mcp = new McpServer({ name: "slow", version: "1.0.0" });
    mcp.registerTool("wait", {
      description: "Never finishes",
      inputSchema: {},
    }, () => new Promise(() => { /* deliberately never settles */ }));
    return mcp;
  }

  function countingPool() {
    const createTransport = vi.fn(async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await slowUpstream().connect(serverSide);
      return clientSide;
    });
    return {
      createTransport,
      pool: createClientPool({ createTransport, log: { warn: vi.fn(), info: vi.fn() } }),
    };
  }

  it("keeps the shared client when one caller aborts", async () => {
    const { createTransport, pool: shared } = countingPool();
    await shared.listTools(server);
    const aborter = new AbortController();
    const call = shared.callTool(server, "wait", {}, {
      signal: aborter.signal, timeoutMs: 60_000,
    });
    aborter.abort();
    await expect(call).rejects.toThrow();

    // One thread pressing stop must not take every other thread's connection -
    // and for a stdio server, the shared child process - down with it.
    await shared.listTools(server);
    expect(createTransport).toHaveBeenCalledTimes(1);
    await shared.closeAll();
  });

  it("keeps the shared client when one call times out", async () => {
    const { createTransport, pool: shared } = countingPool();
    await shared.listTools(server);
    await expect(shared.callTool(server, "wait", {}, {
      signal: new AbortController().signal, timeoutMs: 20,
    })).rejects.toThrow();

    await shared.listTools(server);
    expect(createTransport).toHaveBeenCalledTimes(1);
    await shared.closeAll();
  });
});

describe("client pool schema handling", () => {
  const cyclic = {
    type: "object",
    properties: { node: { $ref: "#/$defs/node" } },
    $defs: {
      node: {
        type: "object",
        properties: { child: { $ref: "#/$defs/node" } },
      },
    },
  };

  function rawPool(tools: unknown[]) {
    const warn = vi.fn();
    const shared = createClientPool({
      async createTransport() {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const raw = new Server(
          { name: "raw", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        raw.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
        await raw.connect(serverSide);
        return clientSide;
      },
      log: { warn, info: vi.fn() },
    });
    return { pool: shared, warn };
  }

  it("skips a tool whose schema is cyclic and keeps the rest of the server", async () => {
    const { pool: shared, warn } = rawPool([
      { name: "tree", description: "Walks a tree", inputSchema: cyclic },
      { name: "fine", description: "Ordinary", inputSchema: { type: "object" } },
    ]);
    const tools = await shared.listTools(server);
    // One unflattenable schema must not cost the user the other 19 tools.
    expect(tools.map((entry) => entry.name)).toEqual(["fine"]);
    expect(warn.mock.calls.flat().join(" ")).toContain("tree");
    await shared.closeAll();
  });
});
