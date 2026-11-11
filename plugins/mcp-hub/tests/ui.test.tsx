// @vitest-environment jsdom
//
// The frontend half: that both slots are registered under the ids the backend
// names, and that the consent prompt maps a click to the decision the gate
// reads. Deliberately not exhaustive component coverage - what is pinned here
// is the wiring that would fail silently.
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONSENT_RENDERER_ID,
  MCP_CHANGED,
  type McpConsentPayload,
  type McpProjectDto,
  type McpRpcContract,
  type McpServerDto,
  type McpToolDto,
} from "../contract.js";

// `renderSlot` mounts into document.body and every query reads from there, so
// without this each test would also see the previous test's DOM. Testing
// Library only registers its own cleanup when vitest runs with globals.
afterEach(cleanup);

beforeAll(() => {
  // Radix reads these on every pointer interaction and jsdom implements none
  // of them.
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    scrollIntoView: () => {},
  });
  // The vendored `DialogContent` measures the viewport to choose between a
  // dialog and a drawer; jsdom ships neither of these.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  // An open `Select` positions itself with floating-ui, which asks every
  // ancestor whether it is in the top layer. nwsapi resolves `:modal` from
  // scratch on every call at roughly half a second each, and one open asks
  // some thirty times - a seventeen-second click, and every test that opens a
  // dropdown timing out. Nothing here is ever in the top layer, so the answer
  // is the one this returns.
  const matches = Element.prototype.matches;
  Element.prototype.matches = function (selector: string): boolean {
    if (selector === ":modal" || selector === ":popover-open") return false;
    return matches.call(this, selector);
  };
});

/**
 * The redirect URI the panel composes, which follows the origin jsdom serves
 * the test document from rather than anything the backend reports.
 */
const REDIRECT_URI = `${globalThis.location.origin}/plugins/mcp-hub/mcp-hub/oauth/callback`;

function httpServer(overrides: Partial<McpServerDto> = {}): McpServerDto {
  return {
    id: "notion", displayName: "Notion", transport: "http", kind: "remote",
    url: "https://mcp.notion.com/mcp", command: null, args: [], env: {}, headers: {},
    cwd: null, enabled: true, createdAt: 1, authStatus: "disconnected",
    alwaysAsk: false, oauthClientId: null, hasOauthClientSecret: false,
    oauthScopes: null, authError: null, registeredRedirectUri: null, ...overrides,
  };
}

function stdioServer(displayName: string, id = displayName.toLowerCase()): McpServerDto {
  return {
    id, displayName, transport: "stdio", kind: "local", url: null, command: "npx",
    args: ["-y", "server-filesystem"], env: {}, headers: {}, cwd: null, enabled: true,
    createdAt: 1, authStatus: null, alwaysAsk: false,
    oauthClientId: null, hasOauthClientSecret: false, oauthScopes: null,
    authError: null, registeredRedirectUri: null,
  };
}

function tool(overrides: Partial<McpToolDto> = {}): McpToolDto {
  return {
    serverId: "notion", upstreamName: "search", registeredName: "notion_search",
    description: "Search Notion pages", readOnly: true, ask: false,
    defaultEnabled: false, stale: false, driftedFromRegistration: false,
    syncedAt: 1, schemaBytes: 120,
    estimatedTokens: 45,
    ...overrides,
  };
}

function app() {
  return loadPluginApp(() => import("../app.js"));
}

const payload: McpConsentPayload = {
  serverName: "Gmail",
  toolName: "gmail_send",
  summary: '{"to":"alice@example.com","subject":"Hi"}',
  destructive: true,
};

function consentProps(
  overrides: Partial<PluginPendingInteractionProps> = {},
): PluginPendingInteractionProps {
  return {
    interaction: {
      id: "int_1",
      threadId: "thread_1",
      title: 'Run "gmail_send" on Gmail?',
      payload,
      createdAt: 0,
      expiresAt: null,
    },
    submit: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Every method the contract declares; the panel only calls some of them. */
function rpcHandlers(
  overrides: Partial<Record<keyof McpRpcContract, unknown>> = {},
) {
  return {
    servers_list: () => ({ servers: [] }),
    servers_add: () => ({ server: null as never }),
    servers_set_oauth_client: () => ({ ok: true }),
    servers_set_headers: () => ({ ok: true }),
    servers_set_enabled: () => ({ ok: true }),
    servers_remove: () => ({ removed: true }),
    servers_connect: () => ({ authorizeUrl: "https://auth.example/authorize" }),
    servers_test: () => ({ ok: true, toolCount: 0, error: null, stderr: [] }),
    catalog_sync: () => ({ added: [], total: 0 }),
    tools_list: () => ({ tools: [] }),
    tool_details: () => ({
      tool: {
        registeredName: "notion_search", description: "Search Notion",
        parameters: [], inputSchema: "{}",
      },
    }),
    tool_set_ask: () => ({ ok: true }),
    bindings_list: () => ({ overrides: [] }),
    binding_set: () => ({ ok: true }),
    tools_set_default: () => ({ updated: 0 }),
    projects_list: () => ({ projects: [] }),
    oauth_complete: () => ({ serverId: "notion", displayName: "Notion" }),
    plugin_reload: () => ({ ok: true }),
    ...overrides,
  } as never;
}

describe("app registration", () => {
  it("registers the panel and the consent renderer under the contract's id", async () => {
    const captured = await app();
    expect(captured.navPanels.map((panel) => panel.id)).toEqual(["mcp-hub"]);
    // The string match is the whole backend-to-frontend link: the gate passes
    // this id to `bb.ui.requestInput`, and a mismatch leaves every write tool
    // waiting on a prompt that never renders.
    expect(captured.pendingInteractions.map((entry) => entry.id))
      .toEqual([CONSENT_RENDERER_ID]);
  });
});

describe("consent prompt", () => {
  it("shows the server, the tool and the arguments being approved", async () => {
    const captured = await app();
    const view = renderSlot(captured.pendingInteractions[0], consentProps());
    // Asserted over the whole prompt: the tool name appears in more than one
    // place on purpose, and what matters is that all three are visible.
    const text = view.baseElement.textContent ?? "";
    expect(text).toContain("gmail_send");
    expect(text).toContain("Gmail");
    expect(text).toContain("alice@example.com");
  });

  it.each([
    ["Allow once", "once"],
    ["Always allow gmail_send in this thread", "thread"],
    ["Deny", "deny"],
  ])("submits %s as %s", async (label, decision) => {
    const captured = await app();
    const props = consentProps();
    const view = renderSlot(captured.pendingInteractions[0], props);
    await userEvent.click(view.getByRole("button", { name: label }));
    expect(props.submit).toHaveBeenCalledWith({ decision });
  });

  it("says a thread grant is not limited to these arguments", async () => {
    const captured = await app();
    const view = renderSlot(captured.pendingInteractions[0], consentProps());
    // A thread grant is argument-independent, and "Allow for this thread"
    // reads to a user as "allow this call".
    expect(view.getByText(/with any\s+arguments/)).toBeDefined();
  });

  it("cancels rather than denies when the payload cannot be read", async () => {
    const captured = await app();
    const props = consentProps({
      interaction: { ...consentProps().interaction, payload: { nope: true } },
    });
    const view = renderSlot(captured.pendingInteractions[0], props);
    await userEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(props.cancel).toHaveBeenCalled();
    expect(props.submit).not.toHaveBeenCalled();
  });
});

describe("connections panel", () => {
  it("switches a server off from its row", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [stdioServer("Files", "files")] }) }),
    });
    await userEvent.click(await view.findByRole("switch", { name: "Disable Files" }));
    const sent = view.inspection.rpcCalls.filter((entry) => entry.method === "servers_set_enabled");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ id: "files", enabled: false });
  });

  it("dims a disabled server and offers to switch it back on", async () => {
    const captured = await app();
    const off = { ...stdioServer("Files", "files"), enabled: false };
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [off] }) }),
    });
    expect(await view.findByRole("switch", { name: "Enable Files" })).toBeDefined();
    expect(view.getByText("1 disabled")).toBeDefined();
  });

  it("filters the server list by name and says so when nothing matches", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [stdioServer("Files", "files"), stdioServer("Search", "search")],
        }),
      }),
    });
    expect(await view.findByText("Files")).toBeDefined();
    await userEvent.type(view.getByLabelText("Filter servers"), "sear");
    expect(view.queryByText("Files")).toBeNull();
    expect(view.getByText("Search")).toBeDefined();
    await userEvent.type(view.getByLabelText("Filter servers"), "zzz");
    expect(await view.findByText(/No servers match/)).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: "Clear Filter" }));
    expect(await view.findByText("Files")).toBeDefined();
  });

  it("shows an empty state with a way to add the first server", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [] }) }),
    });
    await userEvent.click(await view.findByRole("button", { name: "Add First Server" }));
    expect(await view.findByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("keeps the toolbar mounted while the first fetch is in flight", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => new Promise(() => ({})) }),
    });
    expect(view.getByRole("button", { name: "Add Server" })).toBeDefined();
  });

  it("lists a server and shows its stderr tail when Test fails", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [stdioServer("Files", "files")],
        }),
        servers_test: () => ({
          ok: false, toolCount: 0, error: "Error: Connection closed",
          stderr: ["env: node: No such file or directory"],
        }),
      }),
    });
    expect(await view.findByText("Files")).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: /^Test / }));
    // The diagnostic no other MCP client shows.
    expect(await view.findByText(/No such file or directory/)).toBeDefined();
  });

  it("drops a stale test result once a sync succeeds", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [stdioServer("Files", "files")],
        }),
        servers_test: () => ({
          ok: false, toolCount: 0, error: "Error: Connection closed",
          stderr: ["env: node: No such file or directory"],
        }),
      }),
    });
    expect(await view.findByText("Files")).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: /^Test / }));
    expect(await view.findByText(/No such file or directory/)).toBeDefined();
    // A sync that worked has just disproved the failure the tail describes.
    await userEvent.click(view.getByRole("button", { name: /^Settings for / }));
    await userEvent.click(await view.findByRole("button", { name: "Sync tools" }));
    await waitFor(() => {
      expect(view.queryByText(/No such file or directory/)).toBeNull();
    });
  });

  it("does not remove a server until the confirmation is accepted", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [stdioServer("Files", "files")],
        }),
      }),
    });
    expect(await view.findByText("Files")).toBeDefined();

    // Removal lives behind Settings now: a permanently red button on every row
    // made the destructive action as prominent as the one users came for.
    await userEvent.click(view.getByRole("button", { name: /^Settings for / }));
    await userEvent.click(await view.findByRole("button", { name: "Remove Files" }));
    // Removal cascades to the catalog and to every project binding, and the
    // panel cannot undo any of it.
    expect(view.inspection.rpcCalls.some((entry) => entry.method === "servers_remove"))
      .toBe(false);

    await userEvent.click(await view.findByRole("button", { name: "Remove server" }));
    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_remove"))
        .toEqual([{ method: "servers_remove", input: { id: "files" } }]);
    });
  });
});

/**
 * The panel's two staleness rules. `mcp-changed` covers a mutation from
 * anywhere; the reconnect transition covers what that signal cannot, because
 * realtime signals are never replayed and everything published while the
 * socket was down is simply gone.
 */
describe("connections panel staleness", () => {
  async function panel(names: () => string[], initial?: "connecting" | "connected") {
    const captured = await app();
    return renderSlot(
      captured.navPanels[0],
      { subPath: "" },
      {
        rpc: rpcHandlers({
          servers_list: () => ({
            servers: names().map((name) => stdioServer(name))
          }),
        }),
        ...(initial === undefined ? {} : { realtimeConnectionState: initial }),
      },
    );
  }

  it("refetches when something publishes mcp-changed", async () => {
    let names = ["First"];
    const view = await panel(() => names);
    expect(await view.findByText("First")).toBeDefined();
    names = ["Second"];
    await view.behavior.emitRealtime(MCP_CHANGED, null);
    expect(await view.findByText("Second")).toBeDefined();
  });

  it("refetches after a dropped connection comes back", async () => {
    let names = ["First"];
    const view = await panel(() => names);
    expect(await view.findByText("First")).toBeDefined();

    // Whatever was published in here never arrives, so the panel cannot know
    // it is stale - only that it might be.
    await view.behavior.setRealtimeConnectionState("reconnecting");
    names = ["Second"];
    await view.behavior.setRealtimeConnectionState("connected");

    expect(await view.findByText("Second")).toBeDefined();
  });

  it("does not treat the first connection as a reconnection", async () => {
    const view = await panel(() => ["First"], "connecting");
    await view.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => { expect(view.queryByText("First")).not.toBeNull(); });
    // connecting -> connected is the initial handshake; the mount fetch has
    // already covered it, and refetching would double every panel open.
    expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_list"))
      .toHaveLength(1);
  });
});

/**
 * The Add-server form. `env` and `cwd` have been in the record, the schema,
 * the table and `spawn` from the start with no surface that could set them,
 * which blocks every `docker run` server that takes its configuration through
 * the environment.
 */
describe("add server form", () => {
  it("sends environment variables and a working directory for a stdio server", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_add: () => ({ server: stdioServer("VL", "vl") }) }),
    });
    await userEvent.click(view.getByRole("button", { name: "Add Server" }));
    await userEvent.click(await view.findByLabelText("Connection type"));
    await userEvent.click(await view.findByRole("option", { name: /Local command/ }));
    await userEvent.type(await view.findByLabelText("Name"), "VL");
    await userEvent.type(view.getByLabelText("Command"), "docker");
    await userEvent.type(view.getByLabelText("Arguments"), "run vl-mcp");
    // Behind the disclosure: most local servers need neither, and having them
    // open made a two-field form look like a six-field one.
    await userEvent.click(view.getByRole("button", { name: "Advanced" }));
    await userEvent.type(
      await view.findByLabelText("Environment"),
      "VL_INSTANCE_ENTRYPOINT=http://localhost:9428\nVM_INSTANCE_BEARER_TOKEN=s3cret",
    );
    await userEvent.type(view.getByLabelText("Working directory"), "/srv/vl");
    await userEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_add"))
        .toEqual([{
          method: "servers_add",
          input: {
            displayName: "VL", kind: "local" as const, command: "docker",
            args: ["run", "vl-mcp"],
            env: {
              VL_INSTANCE_ENTRYPOINT: "http://localhost:9428",
              VM_INSTANCE_BEARER_TOKEN: "s3cret",
            },
            cwd: "/srv/vl",
          },
        }]);
    });
  });

  it("sends request headers for a remote server", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_add: () => ({ server: httpServer() }) }),
    });
    await userEvent.click(view.getByRole("button", { name: "Add Server" }));
    // "Remote MCP server" is the default, so nothing is chosen here.
    await userEvent.type(await view.findByLabelText("Name"), "VL");
    await userEvent.type(view.getByLabelText("URL"), "https://vl/mcp");
    await userEvent.click(view.getByRole("button", { name: "Advanced" }));
    // The colon in the value is the case a naive split would truncate.
    await userEvent.type(
      await view.findByLabelText("Headers"),
      "Authorization: Bearer a:b\nX-Tenant: acme",
    );
    await userEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_add"))
        .toEqual([{
          method: "servers_add",
          input: {
            displayName: "VL", kind: "remote" as const, url: "https://vl/mcp",
            headers: { Authorization: "Bearer a:b", "X-Tenant": "acme" },
          },
        }]);
    });
  });

  it("says the removal deletes stored credentials too", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [stdioServer("Files", "files")],
        }),
      }),
    });
    expect(await view.findByText("Files")).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: /^Settings for / }));
    await userEvent.click(await view.findByRole("button", { name: "Remove Files" }));
    // The warning listed the catalog and the bindings and said nothing about
    // the access and refresh tokens it also destroys.
    expect(await view.findByText(/credential/i)).toBeDefined();
  });
});

/**
 * The per-server headers. A remote server that does not speak OAuth
 * authenticates with a static token, and until now there was nowhere to put
 * one: the only header this plugin sent was the bearer it minted itself.
 */
describe("headers form", () => {
  it("replaces the whole set, pre-filled with what is stored", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [httpServer({ headers: { "X-Api-Key": "old", "X-Gone": "1" } })]
        }),
      }),
    });
    await userEvent.click(await view.findByRole("button", { name: /^Settings for / }));
    const field = await view.findByLabelText("Headers");
    expect((field as HTMLTextAreaElement).value).toBe("X-Api-Key: old\nX-Gone: 1");

    await userEvent.clear(field);
    await userEvent.type(field, "X-Api-Key: new");
    await userEvent.click(view.getByRole("button", { name: "Save headers" }));

    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_set_headers"))
        // The deleted header is gone rather than merged back in: a header the
        // user removed is exactly the one that must stop being sent.
        .toEqual([{
          method: "servers_set_headers",
          input: { id: "notion", headers: { "X-Api-Key": "new" } },
        }]);
    });
  });
});

/**
 * The per-server OAuth client. Manual client credentials used to be two
 * plugin-wide settings named after Google, so a second server needing one had
 * nowhere to put it and the redirect URI to paste into a GCP or Slack client
 * appeared only inside a thrown error.
 */
describe("oauth client form", () => {
  function panel(server: McpServerDto) {
    return app().then((captured) => renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({ servers: [server] }),
      }),
    }));
  }

  it("calls a header-authenticated server authenticated, and offers it no Connect", async () => {
    const view = await panel(httpServer({
      headers: { Authorization: "Bearer static-token" },
    }));

    // It answers every call it is given; "Not connected" described only the
    // OAuth grant it was never going to have.
    expect(await view.findByText("Header auth")).toBeDefined();
    expect(view.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("keeps Connect for a header that is not the Authorization one", async () => {
    const view = await panel(httpServer({ headers: { "X-Api-Version": "2" } }));

    // A routing header says nothing about how the server authenticates.
    expect(await view.findByRole("button", { name: "Connect" })).toBeDefined();
    expect(view.getByText("Not connected")).toBeDefined();
  });

  it("saves a client id, a secret and scopes for one server", async () => {
    const view = await panel(httpServer());
    await userEvent.click(await view.findByRole("button", { name: /^Settings for / }));
    await userEvent.type(await view.findByLabelText("OAuth client id"), "gcp-id");
    await userEvent.type(view.getByLabelText("OAuth client secret"), "gcp-secret");
    await userEvent.type(view.getByLabelText("OAuth scopes"), "gmail.readonly");
    await userEvent.click(view.getByRole("button", { name: "Save OAuth client" }));

    await waitFor(() => {
      expect(view.inspection.rpcCalls
        .filter((entry) => entry.method === "servers_set_oauth_client"))
        .toEqual([{
          method: "servers_set_oauth_client",
          input: {
            id: "notion", clientId: "gcp-id", clientSecret: "gcp-secret",
            scopes: "gmail.readonly",
          },
        }]);
    });
  });

  it("sends a null secret when the box is left empty, so the stored one survives", async () => {
    const view = await panel(httpServer({
      oauthClientId: "gcp-id", hasOauthClientSecret: true, oauthScopes: "gmail.readonly",
    }));
    await userEvent.click(await view.findByRole("button", { name: /^Settings for / }));
    // The DTO never carries the secret, so the field starts empty over a
    // stored one; sending "" would wipe it on every id correction.
    const secret = await view.findByLabelText("OAuth client secret");
    expect((secret as HTMLInputElement).value).toBe("");
    expect(secret.getAttribute("placeholder")).toMatch(/stored/i);
    await userEvent.type(view.getByLabelText("OAuth client id"), "-2");
    await userEvent.click(view.getByRole("button", { name: "Save OAuth client" }));

    await waitFor(() => {
      expect(view.inspection.rpcCalls
        .filter((entry) => entry.method === "servers_set_oauth_client"))
        .toEqual([{
          method: "servers_set_oauth_client",
          input: {
            id: "notion", clientId: "gcp-id-2", clientSecret: null,
            scopes: "gmail.readonly",
          },
        }]);
    });
  });

  it("shows the redirect uri and copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText },
    });
    const view = await panel(httpServer());
    await userEvent.click(await view.findByRole("button", { name: /^Settings for / }));
    // Every manually created client has to list this, and until now it was
    // only ever quoted inside an error the user had to trigger first.
    expect(await view.findByText(REDIRECT_URI)).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(REDIRECT_URI);
  });

  it("offers nothing to authorize on a stdio server", async () => {
    const view = await panel(stdioServer("Files", "files"));
    expect(await view.findByText("Files")).toBeDefined();
    expect(view.queryByRole("button", { name: "OAuth client" })).toBeNull();
  });
});

/**
 * The tool table's filter and its two modes. One flat list of every tool from
 * every server is unusable once a Notion is connected, and the panel could
 * express neither the global default nor a project's `inherit` - so a project
 * that had never said anything and one that had switched a tool off rendered
 * identically.
 */
describe("tool table", () => {
  const notion = httpServer();
  const linear = httpServer({
    id: "linear", displayName: "Linear", url: "https://mcp.linear.app/mcp",
  });
  const tools = [
    tool(),
    tool({ registeredName: "notion_create", upstreamName: "create", description: "Add a page" }),
    tool({
      serverId: "linear", registeredName: "linear_issue", upstreamName: "issue",
      description: "Open an issue",
    }),
  ];

  function panel(options: {
    tools?: McpToolDto[];
    projects?: McpProjectDto[];
    overrides?: Array<{ registeredName: string; enabled: boolean }>;
    details?: unknown;
  } = {}) {
    return app().then(async (captured) => {
      const view = await renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({
          servers: [notion, linear],
        }),
        tools_list: () => ({ tools: options.tools ?? tools }),
        projects_list: () => ({ projects: options.projects ?? [] }),
        bindings_list: () => ({ overrides: options.overrides ?? [] }),
        ...(options.details === undefined ? {} : { tool_details: () => options.details }),
      }),
    });
      // The tools live on their own tab; every test here starts on it.
      await userEvent.click(await view.findByRole("button", { name: /^Tools/ }));
      return view;
    });
  }

  it("groups tools under their server's name", async () => {
    const view = await panel();
    expect(view.getByText("Notion")).toBeDefined();
    expect(view.getByText("Linear")).toBeDefined();
  });

  /** Radix opens on click and puts every item behind role="option". */
  async function choose(trigger: HTMLElement, option: string): Promise<void> {
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }

  function calls(view: Awaited<ReturnType<typeof panel>>, method: string) {
    return view.inspection.rpcCalls.filter((entry) => entry.method === method);
  }

  it("narrows the list to what matches, and restores it when the search is cleared", async () => {
    const view = await panel();
    expect(await view.findByText("notion_search")).toBeDefined();
    await userEvent.type(view.getByLabelText("Search tools"), "issue");
    // `upstreamName` and `description` are searched too: a user looking for
    // "issue" knows the upstream name, not the prefixed registered one.
    await waitFor(() => { expect(view.queryByText("notion_search")).toBeNull(); });
    expect(view.getByText("linear_issue")).toBeDefined();

    await userEvent.clear(view.getByLabelText("Search tools"));
    expect(await view.findByText("notion_search")).toBeDefined();
  });

  it("shows only the chosen server's tools", async () => {
    const view = await panel();
    expect(await view.findByText("notion_search")).toBeDefined();
    await choose(view.getByLabelText("Filter by server"), "Linear");
    await waitFor(() => { expect(view.queryByText("notion_search")).toBeNull(); });
    expect(view.getByText("linear_issue")).toBeDefined();
  });

  it("says the filter emptied the list, not that no server has been synced", async () => {
    const view = await panel();
    expect(await view.findByText("notion_search")).toBeDefined();
    await userEvent.type(view.getByLabelText("Search tools"), "nothing matches this");
    // The other empty state tells the user to sync a server they already
    // synced, which is advice that cannot work.
    expect(await view.findByText("No tools match this filter.")).toBeDefined();
    expect(view.queryByText(/Sync a server to read its catalog/)).toBeNull();

    await userEvent.click(view.getByRole("button", { name: "Clear" }));
    expect(await view.findByText("notion_search")).toBeDefined();
  });

  it("expands a row into the whole description and what the tool takes", async () => {
    const view = await panel({
      tools: [tool({ description: "Search Notion.\nEvery word after this one is cut off in the row." })],
      details: {
        tool: {
          registeredName: "notion_search",
          description: "Search Notion.\nEvery word after this one is cut off in the row.",
          parameters: [
            { name: "query", type: "string", required: true, description: "What to find" },
            { name: "limit", type: "number", required: false, description: null },
          ],
          inputSchema: '{\n  "type": "object"\n}',
        },
      },
    });

    // Nothing is fetched for a row nobody opened: the details are a call per
    // row, and the catalog can be hundreds of them.
    expect(await view.findByText("notion_search")).toBeDefined();
    expect(calls(view, "tool_details")).toHaveLength(0);

    await userEvent.click(view.getByRole("button", { name: /notion_search/ }));
    expect(await view.findByText(/Every word after this one/)).toBeDefined();
    expect(view.getByText("query")).toBeDefined();
    expect(view.getByText("What to find")).toBeDefined();
    expect(calls(view, "tool_details")).toHaveLength(1);

    // The flattened list is the readable answer; the raw schema is the exact
    // one, and stays out of the way until asked for.
    expect(view.queryByText(/"type": "object"/)).toBeNull();
    await userEvent.click(view.getByRole("button", { name: "Show raw schema" }));
    expect(await view.findByText(/"type": "object"/)).toBeDefined();
  });

  it("prices a tool in tokens, exact only while the exact figure means something", async () => {
    const view = await panel({ tools: [
      tool({ estimatedTokens: 2480 }),
      tool({
        registeredName: "notion_create", upstreamName: "create",
        description: "Add a page", estimatedTokens: 412,
      }),
    ] });
    // Bytes are exact and nobody budgets in them. What the row has to answer
    // is what this tool spends out of a context window.
    expect(await view.findByText("~2.5k tokens, read-only")).toBeDefined();
    expect(view.getByText("~412 tokens, read-only")).toBeDefined();
    expect(view.queryByText(/bytes of schema/)).toBeNull();
  });

  it("sends a drifted tool to a reload rather than to Sync", async () => {
    const view = await panel({ tools: [tool({ driftedFromRegistration: true })] });

    expect(await view.findByText(/notion_search \(reload to update\)/)).toBeDefined();
    // Syncing is what a user reaches for and the one thing that cannot work,
    // so the row has to name the command that does.
    expect(view.getByText(/bb plugin reload mcp/)).toBeDefined();
  });

  it("says nothing about reloading a tool that has not drifted", async () => {
    const view = await panel({ tools: [tool()] });

    expect(await view.findByText("notion_search")).toBeDefined();
    expect(view.queryByText(/reload to update/)).toBeNull();
  });

  it("totals the estimate over the tools the chosen project actually gets", async () => {
    const view = await panel({
      projects: [{ id: "work", name: "Work", personal: false }],
      overrides: [{ registeredName: "notion_delete", enabled: true }],
      tools: [
        tool({ estimatedTokens: 1000, defaultEnabled: true }),
        tool({
          registeredName: "notion_create", upstreamName: "create",
          description: "Add a page", estimatedTokens: 1500, defaultEnabled: true,
        }),
        tool({
          registeredName: "notion_delete", upstreamName: "delete",
          description: "Delete a page", estimatedTokens: 500, defaultEnabled: false,
        }),
      ],
    });
    // Defaults mode: the two default-on rows, and not the one nobody enabled.
    expect(await view.findByText("~2.5k tokens")).toBeDefined();

    // The same set the count is taken over, so an override that adds a tool
    // has to move both numbers or one of them is lying.
    await choose(view.getByLabelText("Project"), "Work");
    expect(await view.findByText("~3.0k tokens")).toBeDefined();
  });

  it("sets a tool's global default from the defaults mode", async () => {
    const view = await panel();
    await userEvent.click(await view.findByLabelText("Enable notion_search by default"));
    await waitFor(() => {
      expect(calls(view, "tools_set_default")).toEqual([{
        method: "tools_set_default",
        input: { registeredNames: ["notion_search"], defaultEnabled: true },
      }]);
    });
  });

  it("enables only the rows the filter left showing", async () => {
    const view = await panel();
    expect(await view.findByText("notion_search")).toBeDefined();
    await choose(view.getByLabelText("Filter by server"), "Linear");
    await userEvent.click(await view.findByRole("button", { name: "Enable all shown" }));
    await waitFor(() => {
      expect(calls(view, "tools_set_default")).toEqual([{
        method: "tools_set_default",
        input: { registeredNames: ["linear_issue"], defaultEnabled: true },
      }]);
    });
  });

  describe("with a project chosen", () => {
    const projects: McpProjectDto[] = [{ id: "work", name: "Work", personal: false }];

    async function withProject(options: {
      tools?: McpToolDto[];
      overrides?: Array<{ registeredName: string; enabled: boolean }>;
    } = {}) {
      const view = await panel({ ...options, projects });
      expect(await view.findByText("notion_search")).toBeDefined();
      await choose(view.getByLabelText("Project"), "Work");
      return view;
    }

    it("reads a tool with no override as the default it follows", async () => {
      const view = await withProject({ tools: [tool({ defaultEnabled: true })] });
      // An absent binding row and a row saying "off" used to render the same,
      // which is the whole reason `bindings_list` reports both.
      const control = await view.findByLabelText("notion_search in this project");
      await waitFor(() => { expect(control.textContent).toContain("Default (on)"); });
    });

    it("forces a tool off for this project alone", async () => {
      const view = await withProject();
      await choose(await view.findByLabelText("notion_search in this project"), "Off");
      await waitFor(() => {
        expect(calls(view, "binding_set")).toEqual([{
          method: "binding_set",
          input: { projectId: "work", registeredName: "notion_search", state: "off" },
        }]);
      });
    });

    it("drops the override when the default item is chosen again", async () => {
      const view = await withProject({
        tools: [tool({ defaultEnabled: true })],
        overrides: [{ registeredName: "notion_search", enabled: false }],
      });
      const control = await view.findByLabelText("notion_search in this project");
      await waitFor(() => { expect(control.textContent).toContain("Off"); });
      // `inherit` deletes the row, so the tool goes on following a default
      // that may flip later; "on" would pin it and stop tracking.
      await choose(control, "Default (on)");
      await waitFor(() => {
        expect(calls(view, "binding_set")).toEqual([{
          method: "binding_set",
          input: { projectId: "work", registeredName: "notion_search", state: "inherit" },
        }]);
      });
    });
  });
});

/**
 * The OAuth return leg, which lands in the panel rather than on the plugin's
 * public HTTP route.
 *
 * That is not a detail: BB is reachable at several origins and some of them
 * gate `/api/...` behind a sign-in, where a callback aimed at the route is
 * answered with a login page and the authorization code is lost. A panel URL
 * is an ordinary app URL, and the exchange goes over the authenticated RPC.
 */
describe("oauth callback", () => {
  it("exchanges the code and says which server connected", async () => {
    const captured = await app();
    globalThis.history.replaceState(null, "", "/?code=abc&state=xyz");
    const view = renderSlot(captured.navPanels[0], { subPath: "oauth/callback" }, {
      rpc: rpcHandlers({}),
    });
    expect(await view.findByText("Connected Notion.")).toBeDefined();
    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "oauth_complete"))
        .toEqual([{ method: "oauth_complete", input: { code: "abc", state: "xyz" } }]);
    });
  });

  it("reports what the service said when the user cancelled", async () => {
    const captured = await app();
    globalThis.history.replaceState(null, "", "/?error=access_denied");
    const view = renderSlot(captured.navPanels[0], { subPath: "oauth/callback" }, {
      rpc: rpcHandlers({}),
    });
    expect(await view.findByText(/access_denied/)).toBeDefined();
    expect(view.inspection.rpcCalls.some((entry) => entry.method === "oauth_complete"))
      .toBe(false);
  });

  it("sends the origin this browser is on, not a loopback address", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [httpServer()] }) }),
    });
    await userEvent.click(await view.findByRole("button", { name: "Connect" }));
    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "servers_connect"))
        .toEqual([{
          method: "servers_connect",
          input: { id: "notion", redirectOrigin: globalThis.location.origin },
        }]);
    });
  });
});

/**
 * Credentials that stopped working, said where someone will see it.
 *
 * The failure mode is nobody looking: a grant an authorization server ended
 * overnight left this plugin answering 401 every seventeen minutes for four
 * days, with the reason in a log file and the panel showing one grey word.
 */
describe("a server whose credentials died", () => {
  const broken = httpServer({
    authStatus: "needs-reconnect",
    authError: { message: "Grant not found. Raise the Grant session duration.", at: 5 },
  });

  it("names the server, the reason and the way out", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [broken] }) }),
    });
    expect(await view.findByText(/Notion needs reconnecting/)).toBeDefined();
    // The reason is the part that says whether reconnecting will help at all.
    expect(view.getAllByText(/Grant session duration/).length).toBeGreaterThan(0);
    // The banner's own button; the row keeps one too, for a user who scrolled
    // past the banner to the server they were looking for.
    await userEvent.click(view.getAllByRole("button", { name: "Reconnect" })[0]);
    await waitFor(() => {
      expect(view.inspection.rpcCalls.some((entry) => entry.method === "servers_connect"))
        .toBe(true);
    });
  });

  it("keeps quiet about a server that is working", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({ servers_list: () => ({ servers: [httpServer()] }) }),
    });
    expect(await view.findByText("Notion")).toBeDefined();
    expect(view.queryByText(/needs reconnecting/)).toBeNull();
  });
});

/**
 * Tools whose descriptions moved after they were registered.
 *
 * `registerTool` has no update, so a sync - the obvious move - cannot help.
 * Adding one integration to a gateway moves nothing but one tool's
 * description, which makes this the normal way a gateway's catalog changes.
 */
describe("drifted tools", () => {
  it("offers the reload that is the only thing which fixes it", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({ servers: [httpServer()] }),
        tools_list: () => ({ tools: [tool({ driftedFromRegistration: true })] }),
      }),
    });
    expect(await view.findByText(/1 tool has changed/)).toBeDefined();
    await userEvent.click(view.getByRole("button", { name: "Reload plugin" }));
    await waitFor(() => {
      expect(view.inspection.rpcCalls.filter((entry) => entry.method === "plugin_reload"))
        .toEqual([{ method: "plugin_reload", input: null }]);
    });
  });

  it("says nothing when every registration still matches", async () => {
    const captured = await app();
    const view = renderSlot(captured.navPanels[0], { subPath: "" }, {
      rpc: rpcHandlers({
        servers_list: () => ({ servers: [httpServer()] }),
        tools_list: () => ({ tools: [tool()] }),
      }),
    });
    expect(await view.findByText("Notion")).toBeDefined();
    expect(view.queryByRole("button", { name: "Reload plugin" })).toBeNull();
  });
});
