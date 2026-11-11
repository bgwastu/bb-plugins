import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientPool } from "../src/mcp/client-pool.js";
import { createStdioSupervisor } from "../src/mcp/stdio.js";
import type { ServerRecord } from "../src/storage/registry.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);
const server: ServerRecord = {
  id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const, url: null,
  command: process.execPath, args: [fixture], env: {}, headers: {}, cwd: null,
  enabled: true, createdAt: 1,
  oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
  authError: null, authErrorAt: null,
};
let supervisor: ReturnType<typeof createStdioSupervisor> | null = null;
afterEach(async () => { await supervisor?.killAll(); supervisor = null; });

const envFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-report-mcp-server.mjs",
);
const noisyFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "noisy-stderr-mcp-server.mjs",
);

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function extractPids(lines: string[]): number[] {
  const pids: number[] = [];
  for (const line of lines) {
    const match = /pid=(\d+)/.exec(line);
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

describe("stdio supervisor", () => {
  it("spawns a child and lists its tools", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    const tools = await pool.listTools(server);
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("captures child stderr instead of inheriting it", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await pool.listTools(server);
    expect(supervisor.stderrTail("echo").join("\n")).toContain("fixture starting");
  });

  it("kills every child on killAll", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await pool.listTools(server);
    await supervisor.killAll();
    expect(supervisor.stderrTail("echo")).toEqual([]);
  });

  it("closes the previous child when respawning the same server id", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });

    await supervisor.transportFor(server);
    await waitFor(() => extractPids(supervisor!.stderrTail("echo")).length >= 1);
    const [pid1] = extractPids(supervisor.stderrTail("echo"));

    await supervisor.transportFor(server);
    await waitFor(() => extractPids(supervisor!.stderrTail("echo")).length >= 2);
    const pids = extractPids(supervisor.stderrTail("echo"));
    const pid2 = pids[pids.length - 1];

    await supervisor.killAll();

    expect(() => process.kill(pid1, 0)).toThrow();
    expect(() => process.kill(pid2, 0)).toThrow();
  });

  it("does not leak arbitrary process.env into the child", async () => {
    process.env.MCP_TEST_LEAK_MARKER = "leak";
    try {
      supervisor = createStdioSupervisor({
        resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
      });
      const envServer: ServerRecord = { ...server, id: "env-report", args: [envFixture] };
      await supervisor.transportFor(envServer);
      await waitFor(() => supervisor!.stderrTail("env-report").join("\n").includes("HAS_LEAK="));
      expect(supervisor.stderrTail("env-report").join("\n")).toContain("HAS_LEAK=false");
    } finally {
      delete process.env.MCP_TEST_LEAK_MARKER;
    }
  });

  it("bounds the stderr ring buffer and flushes a trailing partial line", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const noisyServer: ServerRecord = { ...server, id: "noisy", args: [noisyFixture] };
    await supervisor.transportFor(noisyServer);
    await waitFor(() => {
      const tail = supervisor!.stderrTail("noisy");
      return tail.length > 0 && tail[tail.length - 1] === "trailing-no-newline";
    });
    const tail = supervisor.stderrTail("noisy");
    expect(tail.length).toBeLessThanOrEqual(100);
    expect(tail[tail.length - 1]).toBe("trailing-no-newline");
    expect(tail).not.toContain("line-0");
  });

  it("returns a defensive copy from stderrTail", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await pool.listTools(server);
    const tail = supervisor.stderrTail("echo");
    tail.push("mutated");
    expect(supervisor.stderrTail("echo")).not.toContain("mutated");
  });

  it("records a failed spawn into the stderr ring buffer", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const badServer: ServerRecord = {
      ...server, id: "bad", command: "/nonexistent/command-that-does-not-exist", args: [],
    };
    await supervisor.transportFor(badServer);
    await waitFor(() => supervisor!.stderrTail("bad").length > 0);
    expect(supervisor.stderrTail("bad").join("\n")).toMatch(/ENOENT|error/i);
  });
});
