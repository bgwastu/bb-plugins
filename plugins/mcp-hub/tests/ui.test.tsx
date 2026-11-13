// @vitest-environment jsdom
// The two frontend surfaces, mounted the way BB mounts them: the panel through
// its nav registration and the footer button and popup through a composer
// scope. The host runtime validates the registrations on load.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../app.js"));
});

afterEach(() => {
  cleanup();
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
  lastSeenAt: Date.now() - 5000,
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

const snapshot = {
  servers: [server],
  tools: [tool],
  problems: [],
  offered: 1,
  truncated: false,
};

const selection = {
  servers: [
    {
      id: "echo",
      name: "Echo",
      enabled: true,
      unavailable: null,
      tools: [{ name: "echo_echo", label: "echo", enabled: true, readOnly: false }],
    },
  ],
  offered: 1,
  truncated: false,
  scope: "thread" as const,
};

const rpc = {
  snapshot: vi.fn(async () => snapshot),
  selection_get: vi.fn(async () => selection),
  selection_set: vi.fn(async () => ({ restarted: true, deferred: false, truncated: false, offered: 0 })),
  calls: vi.fn(async () => ({ calls: [] })),
};

describe("the management panel", () => {
  it("lists a server with its state, target and tool count", async () => {
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });
    expect(await screen.findByText("Echo")).toBeDefined();
    expect(screen.getByText("node server.mjs")).toBeDefined();
    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.getByText(/1 tool · /)).toBeDefined();
  });

  it("opens a server's drawer with its tools and its own switch", async () => {
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });
    fireEvent.click(await screen.findByText("Echo"));
    expect(await screen.findByText("Tools")).toBeDefined();
    fireEvent.click(screen.getByText("echo"));
    expect(await screen.findByText(/registered as echo_echo/)).toBeDefined();
  });

  it("opens the add form and offers both kinds of server", async () => {
    renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, pluginId: "mcp-hub" });
    const [headerAdd] = await screen.findAllByText("Add server");
    fireEvent.click(headerAdd!);
    expect(await screen.findByText("Add an MCP server")).toBeDefined();
    expect(screen.getByText("Remote server")).toBeDefined();
    expect(screen.getByText("Local command")).toBeDefined();
  });
});

describe("the composer footer", () => {
  const customization = () => app.composerCustomizations[0]!;

  it("shows how many tools this conversation has", async () => {
    const action = customization().actions![0]!;
    renderSlot(
      { component: action.component },
      {},
      {
        rpc,
        pluginId: "mcp-hub",
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
      },
    );
    expect(await screen.findByText("MCP")).toBeDefined();
    expect(await screen.findByText("1")).toBeDefined();
  });

  it("saves only what was switched, as a delta", async () => {
    const popup = customization().experimental_popups![0]!;
    renderSlot(
      { component: popup.component },
      {},
      {
        rpc,
        pluginId: "mcp-hub",
        composer: { scope: { kind: "thread", threadId: "thread-1" } },
      },
    );

    // Expand the server, then switch its only tool off.
    fireEvent.click(await screen.findByText("Echo"));
    await screen.findByText("echo");
    const switches = screen.getAllByRole("switch");
    // The first switch is the server, the second the tool under it.
    fireEvent.click(switches[1]!);

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(rpc.selection_set).toHaveBeenCalled());
    expect(rpc.selection_set).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        tools: { echo_echo: false },
        clearedTools: [],
        apply: true,
      }),
    );
  });

  it("tells a new-thread composer that the choice is for the project", async () => {
    const popup = customization().experimental_popups![0]!;
    renderSlot(
      { component: popup.component },
      {},
      {
        rpc,
        pluginId: "mcp-hub",
        composer: { scope: { kind: "new-thread", projectId: "proj_1" } },
      },
    );
    expect(await screen.findByText("MCP tools")).toBeDefined();
    expect(screen.getByText("For new threads in this project")).toBeDefined();
  });
});
