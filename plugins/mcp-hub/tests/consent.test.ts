import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginAgentToolContext,
  PluginAgentToolResult,
  PluginInteractionRequest,
  PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSENT_RENDERER_ID, consentPayloadSchema } from "../contract.js";
import plugin from "../server.js";
import { CONSENT_TIMEOUT_MS, createConsentGate, withConsent } from "../src/consent.js";
import type { CatalogTool } from "../src/storage/registry.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => {
  await host?.harness.lifecycle.dispose();
  host = null;
});

async function setup(): Promise<ReturnType<typeof createFakePluginHost>> {
  host = createFakePluginHost({ pluginId: "mcp-hub" });
  await plugin(host.bb);
  await host.harness.behavior.callRpc("servers_add", {
    displayName: "Echo", kind: "local" as const,
    command: process.execPath, args: [fixture],
  });
  await host.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
  await host.harness.behavior.callRpc("tool_set_ask", {
    serverId: "echo", upstreamName: "echo", ask: true,
  });
  return host;
}

function tool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    serverId: "echo", upstreamName: "echo", registeredName: "echo",
    description: "Echo text", inputSchema: { type: "object" },
    readOnly: false, ask: true, askOverridden: false, defaultEnabled: false,
    stale: false, syncedAt: 1, ...overrides,
  };
}

function context(threadId = "t1"): PluginAgentToolContext {
  return { threadId, projectId: "p1", signal: new AbortController().signal };
}

type RequestInput = (
  request: PluginInteractionRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginInteractionResult>;

/** A `requestInput` whose every call is settled by the test, one at a time. */
function scriptedInput(): {
  calls: PluginInteractionRequest[];
  requestInput: RequestInput;
  submit(index: number, decision: "once" | "thread" | "deny"): void;
} {
  const calls: PluginInteractionRequest[] = [];
  const settlers: Array<(result: PluginInteractionResult) => void> = [];
  return {
    calls,
    requestInput: (request) => {
      calls.push(request);
      return new Promise<PluginInteractionResult>((resolve) => settlers.push(resolve));
    },
    submit(index, decision) {
      settlers[index]({ outcome: "submitted", value: { decision } });
    },
  };
}

function gateWith(requestInput: RequestInput): ReturnType<typeof createConsentGate> {
  return createConsentGate({ requestInput, serverName: () => "Echo" });
}

describe("consent gate", () => {
  it("prompts before a write and proceeds when allowed", async () => {
    const active = await setup();
    const call = active.harness.behavior.callAgentTool("echo", { text: "hi" });
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    const [pending] = active.harness.inspection.pendingInteractions;
    expect(pending.rendererId).toBe(CONSENT_RENDERER_ID);
    const payload = consentPayloadSchema.parse(pending.payload);
    expect(payload).toMatchObject({ serverName: "Echo", toolName: "echo" });
    expect(payload.summary).toContain("hi");
    active.harness.behavior.submitInteraction(pending.id, { decision: "once" });
    expect(JSON.stringify(await call)).toContain("hi");
  });

  it("returns an error result when the user denies", async () => {
    const active = await setup();
    const call = active.harness.behavior.callAgentTool("echo", { text: "hi" });
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.cancelInteraction(
      active.harness.inspection.pendingInteractions[0].id,
    );
    const result = await call;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/declined|cancelled/i);
  });

  it("asks once when the user allows for the thread", async () => {
    const active = await setup();
    const first = active.harness.behavior.callAgentTool("echo", { text: "a" });
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.submitInteraction(
      active.harness.inspection.pendingInteractions[0].id, { decision: "thread" },
    );
    await first;
    await active.harness.behavior.callAgentTool("echo", { text: "b" });
    expect(active.harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("does not prompt for a readOnly tool", async () => {
    const active = await setup();
    await active.harness.behavior.callRpc("tool_set_ask", {
      serverId: "echo", upstreamName: "echo", ask: false,
    });
    await active.harness.behavior.callAgentTool("echo", { text: "x" });
    expect(active.harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("queues a second parallel call behind the first prompt", async () => {
    // Both Claude and Codex emit parallel tool calls and a thread holds one
    // interaction at a time, so without the mutex the second requestInput
    // would throw and deny a call the user never saw.
    const active = await setup();
    const first = active.harness.behavior.callAgentTool("echo", { text: "a" });
    const second = active.harness.behavior.callAgentTool("echo", { text: "b" });
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(active.harness.inspection.pendingInteractions).toHaveLength(1);

    active.harness.behavior.submitInteraction(
      active.harness.inspection.pendingInteractions[0].id, { decision: "thread" },
    );
    const [a, b] = await Promise.all([first, second]);
    expect(JSON.stringify(a)).toContain("a");
    expect(JSON.stringify(b)).toContain("b");
    expect(active.harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("forgets a thread's allowance when the thread is deleted", async () => {
    const active = await setup();
    const first = active.harness.behavior.callAgentTool(
      "echo", { text: "a" }, { threadId: "t-gone" },
    );
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.submitInteraction(
      active.harness.inspection.pendingInteractions[0].id, { decision: "thread" },
    );
    await first;

    await active.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "t-gone" }),
    });

    const again = active.harness.behavior.callAgentTool(
      "echo", { text: "b" }, { threadId: "t-gone" },
    );
    await vi.waitFor(() =>
      expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.submitInteraction(
      active.harness.inspection.pendingInteractions[0].id, { decision: "once" },
    );
    expect(JSON.stringify(await again)).toContain("b");
  });
});

describe("consent gate internals", () => {
  it("reads the thread allowance after the queue, not before", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const first = gate.check(tool(), { text: "a" }, context());
    const second = gate.check(tool(), { text: "b" }, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    // The second check is parked on the mutex, so it has not prompted yet.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(script.calls).toHaveLength(1);

    script.submit(0, "thread");
    expect(await first).toEqual({ allowed: true });
    // It re-reads the cache after the queue, so the grant covers it.
    expect(await second).toEqual({ allowed: true });
    expect(script.calls).toHaveLength(1);
  });

  it("asks again for a second call when the first was allowed once", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const first = gate.check(tool(), { text: "a" }, context());
    const second = gate.check(tool(), { text: "b" }, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    script.submit(0, "once");
    expect(await first).toEqual({ allowed: true });

    await vi.waitFor(() => expect(script.calls).toHaveLength(2));
    script.submit(1, "deny");
    expect(await second).toMatchObject({ allowed: false });
  });

  it("keeps a thread allowance out of another thread", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const first = gate.check(tool(), {}, context("t1"));
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    script.submit(0, "thread");
    await first;

    const other = gate.check(tool(), {}, context("t2"));
    await vi.waitFor(() => expect(script.calls).toHaveLength(2));
    expect(script.calls[1].threadId).toBe("t2");
    script.submit(1, "deny");
    expect(await other).toMatchObject({ allowed: false });
  });

  it("does not carry a thread allowance to another tool", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const first = gate.check(tool(), {}, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    script.submit(0, "thread");
    await first;

    const other = gate.check(
      tool({ upstreamName: "send", registeredName: "send" }), {}, context(),
    );
    await vi.waitFor(() => expect(script.calls).toHaveLength(2));
    script.submit(1, "deny");
    expect(await other).toMatchObject({ allowed: false });
  });

  it("refuses retryably when a foreign interaction holds the slot", async () => {
    // Claude's own AskUserQuestion, or a permission prompt: requestInput
    // throws rather than queueing, and a throw here would fail the turn.
    const gate = gateWith(() => {
      throw new Error("thread t1 already has a pending interaction");
    });
    const result = await gate.check(tool(), {}, context());
    if (result.allowed) throw new Error("a throwing prompt must not allow the call");
    expect(result.reason).toMatch(/again/i);
  });

  it("keeps serving a thread after a prompt throws", async () => {
    let calls = 0;
    const gate = createConsentGate({
      serverName: () => "Echo",
      async requestInput() {
        calls += 1;
        if (calls === 1) throw new Error("busy");
        return { outcome: "submitted", value: { decision: "once" } };
      },
    });
    expect(await gate.check(tool(), {}, context())).toMatchObject({ allowed: false });
    expect(await gate.check(tool(), {}, context())).toEqual({ allowed: true });
  });

  it("refuses every cancellation with a reason that names the tool", async () => {
    for (const reason of [
      "user", "timeout", "thread-stopped", "thread-deleted",
      "plugin-disposed", "server-restarted", "request-aborted",
    ] as const) {
      const gate = gateWith(async () => ({ outcome: "cancelled", reason }));
      const result = await gate.check(tool(), {}, context());
      if (result.allowed) throw new Error(`cancellation "${reason}" must refuse`);
      expect(result.reason).toContain("echo");
    }
  });

  it("refuses a response it cannot read", async () => {
    const gate = gateWith(async () => ({
      outcome: "submitted", value: { decision: "yes" },
    }));
    expect(await gate.check(tool(), {}, context())).toMatchObject({ allowed: false });
  });

  it("truncates a huge argument object and passes the signal through", async () => {
    const seen: Array<{ request: PluginInteractionRequest; signal?: AbortSignal }> = [];
    const gate = createConsentGate({
      serverName: () => "Echo",
      async requestInput(request, options) {
        seen.push({ request, signal: options?.signal });
        return { outcome: "submitted", value: { decision: "once" } };
      },
    });
    const ctx = context();
    await gate.check(tool(), { blob: "x".repeat(50_000) }, ctx);
    const payload = consentPayloadSchema.parse(seen[0].request.payload);
    expect(payload.summary.length).toBeLessThanOrEqual(800);
    expect(payload.summary).toContain("blob");
    expect(seen[0].request.timeoutMs).toBe(CONSENT_TIMEOUT_MS);
    expect(seen[0].signal).toBe(ctx.signal);
    // The host rejects a payload over 64 KiB outright, which would deny a
    // call the user never saw.
    expect(Buffer.byteLength(JSON.stringify(seen[0].request.payload), "utf8"))
      .toBeLessThan(64 * 1024);
  });

  it("summarizes arguments JSON.stringify cannot render", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const call = gate.check(tool(), circular, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    expect(() => consentPayloadSchema.parse(script.calls[0].payload)).not.toThrow();
    script.submit(0, "deny");
    await call;
  });

  it("keeps an over-long title inside the host's budget", async () => {
    const seen: PluginInteractionRequest[] = [];
    const gate = createConsentGate({
      serverName: () => "S".repeat(80),
      async requestInput(request) {
        seen.push(request);
        return { outcome: "submitted", value: { decision: "once" } };
      },
    });
    await gate.check(tool({ upstreamName: "n".repeat(200) }), {}, context());
    expect(seen[0].title.length).toBeLessThanOrEqual(160);
    // Both names survive the clamp: "which server is this going to" is half
    // of what the user is being asked.
    expect(seen[0].title).toContain("nnn");
    expect(seen[0].title).toContain("SSS");
  });

  it("never prompts for a tool whose ask flag is off", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    expect(await gate.check(tool({ ask: false }), {}, context()))
      .toEqual({ allowed: true });
    expect(script.calls).toEqual([]);
  });

  it("drops a forgotten thread's allowance", async () => {
    const script = scriptedInput();
    const gate = gateWith(script.requestInput);
    const first = gate.check(tool(), {}, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(1));
    script.submit(0, "thread");
    await first;
    gate.forgetThread("t1");

    const again = gate.check(tool(), {}, context());
    await vi.waitFor(() => expect(script.calls).toHaveLength(2));
    script.submit(1, "once");
    expect(await again).toEqual({ allowed: true });
  });
});

describe("withConsent", () => {
  it("does not run the tool when consent is refused", async () => {
    const execute = vi.fn(async () => "ran" as PluginAgentToolResult);
    const gate = gateWith(async () => ({ outcome: "cancelled", reason: "user" }));
    const result = await withConsent(execute, gate)(tool(), {}, context());
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("runs the tool once consent is given", async () => {
    const execute = vi.fn(async () => "ran" as PluginAgentToolResult);
    const gate = gateWith(async () => ({
      outcome: "submitted", value: { decision: "once" },
    }));
    expect(await withConsent(execute, gate)(tool(), { a: 1 }, context())).toBe("ran");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
