// @vitest-environment jsdom
// The two frontend surfaces, mounted the way BB mounts them: the panel through
// its nav registration and the footer button and popup through a composer
// scope. The host runtime validates the registrations on load.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app.js"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const server = {
  id: "echo",
  name: "Echo",
  transport: "stdio" as const,
  url: null,
  command: "node",
  args: ["server.mjs"],
  cwd: null,
  auth: "none" as const,
  oauthClientId: null,
  oauthScopes: null,
  enabled: true,
  createdAt: 1,
  lastSeenAt: null,
  hasBearer: false,
  hasHeaders: false,
  hasEnv: false,
  hasOAuthClientSecret: false,
  redirectUri: null,
  registeredRedirectUri: null,
  state: "ready" as const,
  protocol: "stdio" as const,
  toolCount: 1,
  error: null,
  authorizationUrl: null,
};

const tool = {
  serverId: "echo",
  name: "echo_echo",
  upstreamName: "echo",
  title: null,
  description: "Echo text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readOnly: false,
  enabled: true,
  missing: false,
  problem: null,
};

function rpcStubs(overrides: { enabled?: boolean } = {}) {
  return {
    snapshot: vi.fn(async () => ({
      servers: [{ ...server, enabled: overrides.enabled ?? true }],
      tools: [tool],
      problems: [],
      offered: 1,
      truncated: false,
    })),
    calls: vi.fn(async () => ({ calls: [] })),
    server_enabled: vi.fn(async () => ({})),
    restart_thread: vi.fn(async () => ({ restarted: true, deferred: false })),
  };
}

describe("the management panel", () => {
  it("is one row with a switch, and no dashboard", async () => {
    const rpc = rpcStubs();
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });

    expect(await screen.findByText("Echo")).toBeDefined();
    expect(screen.getByText("node server.mjs")).toBeDefined();
    expect(screen.getByText("MCP servers")).toBeDefined();

    // The old header counted servers and tools; the row carried state, tool
    // count and last-seen. None of that is here any more.
    expect(screen.queryByText(/configured/)).toBeNull();
    expect(screen.queryByText(/offered to agents/)).toBeNull();
    expect(screen.queryByText(/never/)).toBeNull();
    expect(screen.queryByText(/Refresh all/)).toBeNull();
    expect(screen.queryByText(/^Connected$|^Not connected$/)).toBeNull();

    // One switch on the row, and it flips the global answer.
    const toggle = screen.getByRole("switch", { name: "Echo on" });
    fireEvent.click(toggle);
    await waitFor(() => expect(rpc.server_enabled).toHaveBeenCalledWith({ id: "echo", enabled: false }));
  });

  it("opens a server's drawer with its tools", async () => {
    const rpc = rpcStubs();
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });

    fireEvent.click(await screen.findByText("Echo"));
    expect(await screen.findByText("Recent calls")).toBeDefined();
    expect(screen.getByText("echo")).toBeDefined();
    // The drawer does not repeat the switch or claim a last-seen that never
    // happened.
    expect(screen.queryByText(/last seen/)).toBeNull();
  });

  it("opens the add form", async () => {
    const rpc = rpcStubs();
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });

    fireEvent.click(await screen.findByText("Add server"));
    expect(await screen.findByText("Add an MCP server")).toBeDefined();
  });
});

describe("the composer footer", () => {
  const customization = () => app.composerCustomizations[0]!;

  it("counts servers, not tools, in a full-width button", async () => {
    const rpc = rpcStubs();
    renderSlot(
      { component: customization().actions![0]!.component },
      {},
      { rpc, pluginId: "mcp-hub", composer: { scope: { kind: "thread", threadId: "thread-1" } } },
    );
    const button = await screen.findByRole("button", { name: "Choose which MCP servers are on" });
    expect(button.className).toContain("w-full");
    expect(await screen.findByText("1 on")).toBeDefined();
  });

  it("holds a disabled button until the list arrives", async () => {
    // A snapshot that never resolves: the button must still be there, and it
    // must not be clickable.
    const rpc = { ...rpcStubs(), snapshot: vi.fn(() => new Promise<never>(() => undefined)) };
    renderSlot(
      { component: customization().actions![0]!.component },
      {},
      { rpc, pluginId: "mcp-hub", composer: { scope: { kind: "thread", threadId: "thread-1" } } },
    );
    const button = await screen.findByRole("button", { name: "Choose which MCP servers are on" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("MCP")).toBeDefined();
  });

  it("says off when every server is off", async () => {
    const rpc = rpcStubs({ enabled: false });
    renderSlot(
      { component: customization().actions![0]!.component },
      {},
      { rpc, pluginId: "mcp-hub", composer: { scope: { kind: "thread", threadId: "thread-1" } } },
    );
    expect(await screen.findByText("off")).toBeDefined();
  });

  it("flips the same global switch from the popup", async () => {
    const rpc = rpcStubs();
    renderSlot(
      { component: customization().experimental_popups![0]!.component },
      {},
      { rpc, pluginId: "mcp-hub", composer: { scope: { kind: "thread", threadId: "thread-1" } } },
    );

    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(rpc.server_enabled).toHaveBeenCalledWith({ id: "echo", enabled: false }));

    // Only after a change does the popup offer to restart the thread, and it
    // is one link plus one action - no per-thread save.
    fireEvent.click(await screen.findByText("Restart thread"));
    await waitFor(() =>
      expect(rpc.restart_thread).toHaveBeenCalledWith({ threadId: "thread-1", interrupt: false }),
    );
    expect(screen.getByText("Manage servers")).toBeDefined();
    expect(screen.getByText("1 of 1 on")).toBeDefined();
    expect(screen.queryByText(/All settings/)).toBeNull();
    expect(screen.queryByText(/For this conversation/)).toBeNull();
  });

  it("offers no restart outside a thread", async () => {
    const rpc = rpcStubs();
    renderSlot(
      { component: customization().experimental_popups![0]!.component },
      {},
      { rpc, pluginId: "mcp-hub", composer: { scope: { kind: "new-thread", projectId: "proj_1" } } },
    );

    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(rpc.server_enabled).toHaveBeenCalled());
    expect(screen.queryByText("Restart thread")).toBeNull();
    expect(within(document.body).getByText("Manage servers")).toBeDefined();
  });
});
