import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolRegistrationBase,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createSelectionStore, resolveSelection } from "../src/server/configure.js";
import {
  driftedToolNames,
  registerCatalogTools,
  registeredToolOwners,
  statusLabel,
} from "../src/server/tools.js";
import { createRegistry, type CatalogTool, type Registry } from "../src/storage/registry.js";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";

type FakeRegistration = PluginAgentToolRegistrationBase & {
  parameters: Record<string, unknown>;
  execute(params: unknown, ctx: PluginAgentToolContext): Promise<PluginAgentToolResult>;
};

/** The two members `registerCatalogTools` touches, with the host's own
 * duplicate-name rule so a double registration fails here too. */
function fakeBb() {
  const registered: FakeRegistration[] = [];
  const warnings: string[] = [];
  const bb = {
    agents: {
      registerTool(tool: FakeRegistration) {
        if (registered.some((existing) => existing.name === tool.name)) {
          throw new Error(`tool "${tool.name}" is already registered`);
        }
        registered.push(tool);
      },
    },
    log: { warn: (message: string) => warnings.push(message) },
  } as unknown as BbPluginApi;
  return { bb, registered, warnings };
}

function registry(): Registry {
  const handle = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) handle.exec(statement);
  const store = createRegistry(handle);
  store.upsertServer({
    id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const, url: null,
    command: "node", args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
    oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
    authError: null, authErrorAt: null,
  });
  return store;
}

function row(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    serverId: "echo", upstreamName: "echo", registeredName: "echo",
    description: "Echo text", inputSchema: { type: "object" },
    readOnly: false, ask: true, askOverridden: false, defaultEnabled: false,
    stale: false, syncedAt: 1,
    ...overrides,
  };
}

const ctx: PluginAgentToolContext = {
  threadId: "t1", projectId: "p1", signal: new AbortController().signal,
};

describe("catalog tool registration", () => {
  it("registers each fresh row once, however often it runs", () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    const { bb, registered } = fakeBb();
    const execute = vi.fn(async () => "ok" as PluginAgentToolResult);

    registerCatalogTools(bb, { registry: store, execute });
    // A background sync re-registers the diff; re-registering a known name
    // would throw inside the host and lose every later tool in the loop.
    registerCatalogTools(bb, { registry: store, execute });

    expect(registered.map((tool) => tool.name)).toEqual(["echo"]);
    expect([...registeredToolOwners(bb).keys()]).toEqual(["echo"]);
  });

  it("skips a stale row but registers it once it comes back", () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    store.replaceCatalog("echo", []);
    const { bb, registered } = fakeBb();
    const execute = vi.fn(async () => "ok" as PluginAgentToolResult);

    registerCatalogTools(bb, { registry: store, execute });
    expect(registered).toEqual([]);

    store.replaceCatalog("echo", [row()]);
    registerCatalogTools(bb, { registry: store, execute });
    expect(registered.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("keeps a long tool name inside the label budget", () => {
    const store = registry();
    const long = "a".repeat(120);
    store.replaceCatalog("echo", [row({ upstreamName: long })]);
    const { bb, registered, warnings } = fakeBb();

    registerCatalogTools(bb, { registry: store, execute: vi.fn() });
    const label = registered[0].presentation?.label;
    expect(label?.pending.length).toBeLessThanOrEqual(80);
    expect(label?.completed.length).toBeLessThanOrEqual(80);
    expect(label?.pending.startsWith("Running aaa")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("never splits a surrogate pair when it shortens a label", () => {
    const label = statusLabel("Running ", "x".repeat(60) + "\u{1F600}".repeat(20));
    expect(label.length).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDFFF]/.test(label.replace(/[\u{10000}-\u{10FFFF}]/gu, ""))).toBe(false);
  });

  it("substitutes a description when the server supplies none", () => {
    const store = registry();
    store.replaceCatalog("echo", [row({ description: "" })]);
    const { bb, registered } = fakeBb();
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });
    expect(registered[0].description).toContain("echo");
    expect(registered[0].description.trim()).not.toBe("");
  });

  it("re-reads the row on every call instead of closing over it", async () => {
    const store = registry();
    store.replaceCatalog("echo", [row({ ask: true })]);
    const { bb, registered } = fakeBb();
    const seen: CatalogTool[] = [];
    registerCatalogTools(bb, {
      registry: store,
      execute: async (tool) => {
        seen.push(tool);
        return "ok";
      },
    });

    // A tool cannot be re-registered, so a later `ask` change is only visible
    // if execute reads the row at call time.
    store.setToolAsk("echo", "echo", false);
    await registered[0].execute({}, ctx);
    expect(seen[0].ask).toBe(false);
  });

  it("reports a vanished server instead of failing the turn", async () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    const { bb, registered } = fakeBb();
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    store.deleteServer("echo");
    const result = await registered[0].execute({}, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("echo");
  });

  it("reports a stale row instead of calling upstream", async () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    const { bb, registered } = fakeBb();
    const execute = vi.fn(async () => "ok" as PluginAgentToolResult);
    registerCatalogTools(bb, { registry: store, execute });

    store.replaceCatalog("echo", []);
    const result = await registered[0].execute({}, ctx);
    expect(result).toMatchObject({ isError: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("logs and carries on when the host refuses a tool", () => {
    const store = registry();
    store.replaceCatalog("echo", [
      row({ upstreamName: "bad", registeredName: "bad" }),
      row({ upstreamName: "good", registeredName: "good" }),
    ]);
    const { bb, registered, warnings } = fakeBb();
    const agents = bb.agents as unknown as { registerTool(tool: FakeRegistration): void };
    const real = agents.registerTool.bind(agents);
    agents.registerTool = (tool: FakeRegistration) => {
      if (tool.name === "bad") throw new Error("refused");
      real(tool);
    };

    registerCatalogTools(bb, { registry: store, execute: vi.fn() });
    expect(registered.map((tool) => tool.name)).toEqual(["good"]);
    expect(warnings.join("\n")).toContain("bad");
    // A refused name must never be reported as registered: it would reach
    // configure(), where an unknown name rejects this plugin's COMPLETE
    // selection and takes "good" down with it.
    expect([...registeredToolOwners(bb).keys()]).toEqual(["good"]);
  });

  it("keeps a refused tool out of the project selection", () => {
    const store = registry();
    store.replaceCatalog("echo", [
      row({ upstreamName: "bad", registeredName: "bad" }),
      row({ upstreamName: "good", registeredName: "good" }),
    ]);
    store.setBinding("proj_a", "bad", true);
    store.setBinding("proj_a", "good", true);
    const { bb } = fakeBb();
    const agents = bb.agents as unknown as { registerTool(tool: FakeRegistration): void };
    const real = agents.registerTool.bind(agents);
    agents.registerTool = (tool: FakeRegistration) => {
      // What BB does with, say, a schema it reads as recursive.
      if (tool.name === "bad") throw new Error("refused");
      real(tool);
    };
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    const selection = createSelectionStore({
      registry: store,
      registeredOwners: () => registeredToolOwners(bb),
      log: { warn: vi.fn() },
    });
    selection.refresh();
    expect(resolveSelection(selection.snapshot(), "proj_a")).toEqual(["good"]);
  });
});

/**
 * `attemptedNames`/`acceptedNames` outlive the catalog rows they describe:
 * they live for the whole plugin load, the rows do not. Remove a server and
 * add another inside one load and a bare name can be handed out twice.
 */
describe("catalog tool registration across servers", () => {
  function twoServers(): Registry {
    const handle = new Database(":memory:");
    for (const statement of MCP_MIGRATIONS) handle.exec(statement);
    const store = createRegistry(handle);
    for (const id of ["notion", "linear"]) {
      store.upsertServer({
        id, displayName: id, transport: "http", kind: "remote" as const,
        url: `https://${id}.test/mcp`,
        command: null, args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
        oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
        authError: null, authErrorAt: null,
      });
    }
    return store;
  }

  it("never dispatches a name to a server other than the one it advertises", async () => {
    const store = twoServers();
    store.replaceCatalog("notion", [row({
      serverId: "notion", upstreamName: "search", registeredName: "search",
      description: "Search Notion",
    })]);
    const { bb, registered } = fakeBb();
    const execute = vi.fn(async () => "ok" as PluginAgentToolResult);
    registerCatalogTools(bb, { registry: store, execute });
    expect(registered.map((tool) => tool.name)).toEqual(["search"]);

    // Notion goes, Linear arrives, and `resolveName` hands out the bare
    // `search` again because no persisted row holds it any more.
    store.deleteServer("notion");
    store.replaceCatalog("linear", [row({
      serverId: "linear", upstreamName: "search", registeredName: "search",
      description: "Search Linear",
    })]);
    registerCatalogTools(bb, { registry: store, execute });

    // There is still exactly one registration and it carries Notion's
    // description and schema. It must not reach Linear.
    expect(registered).toHaveLength(1);
    const result = await registered[0].execute({}, ctx);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it("stops offering a name whose registration no longer matches the catalog", () => {
    const store = twoServers();
    store.replaceCatalog("notion", [row({
      serverId: "notion", upstreamName: "search", registeredName: "search",
    })]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    store.deleteServer("notion");
    store.replaceCatalog("linear", [row({
      serverId: "linear", upstreamName: "search", registeredName: "search",
    })]);
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });
    store.setBinding("proj_a", "search", true);

    const selection = createSelectionStore({
      registry: store,
      registeredOwners: () => registeredToolOwners(bb),
      log: { warn: vi.fn() },
    });
    selection.refresh();
    // Offering it would show the model Notion's schema over Linear's tool.
    expect(resolveSelection(selection.snapshot(), "proj_a")).toEqual([]);
  });
});

/**
 * A default reaches every project at once, so anything that makes a tool
 * uncallable has to stop it BEFORE it becomes a default rather than in the
 * one project that bound it.
 */
describe("default-enabled tools", () => {
  function store(): Registry {
    const handle = new Database(":memory:");
    for (const statement of MCP_MIGRATIONS) handle.exec(statement);
    const created = createRegistry(handle);
    created.upsertServer({
      id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const, url: null,
      command: "node", args: [], env: {}, headers: {}, cwd: null, enabled: true, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    return created;
  }

  function selectionFor(registry: Registry, bb: BbPluginApi) {
    const selection = createSelectionStore({
      registry, registeredOwners: () => registeredToolOwners(bb), log: { warn: vi.fn() },
    });
    selection.refresh();
    return selection;
  }

  it("offers a default to a project with no binding row of its own", () => {
    const registry = store();
    registry.replaceCatalog("echo", [row({ defaultEnabled: true })]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry, execute: vi.fn() });
    expect(resolveSelection(selectionFor(registry, bb).snapshot(), "never-seen"))
      .toEqual(["echo"]);
  });

  it("drops a default whose tool vanished from the server", () => {
    const registry = store();
    registry.replaceCatalog("echo", [row({ defaultEnabled: true })]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry, execute: vi.fn() });
    registry.replaceCatalog("echo", []);
    expect(resolveSelection(selectionFor(registry, bb).snapshot(), "proj_a")).toEqual([]);
  });

  it("drops a default the host refused to register", () => {
    const registry = store();
    registry.replaceCatalog("echo", [
      row({ upstreamName: "bad", registeredName: "bad", defaultEnabled: true }),
      row({ upstreamName: "good", registeredName: "good", defaultEnabled: true }),
    ]);
    const { bb } = fakeBb();
    const agents = bb.agents as unknown as { registerTool(tool: FakeRegistration): void };
    const real = agents.registerTool.bind(agents);
    agents.registerTool = (tool: FakeRegistration) => {
      if (tool.name === "bad") throw new Error("refused");
      real(tool);
    };
    registerCatalogTools(bb, { registry, execute: vi.fn() });
    // "bad" is a name the model may not call, and one of those rejects the
    // plugin's whole selection - in every project, now that it is a default.
    expect(resolveSelection(selectionFor(registry, bb).snapshot(), "proj_a"))
      .toEqual(["good"]);
  });

  it("drops a default whose server is switched off", () => {
    const registry = store();
    registry.replaceCatalog("echo", [row({ defaultEnabled: true })]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry, execute: vi.fn() });
    registry.upsertServer({
      id: "echo", displayName: "Echo", transport: "stdio", kind: "local" as const, url: null,
      command: "node", args: [], env: {}, headers: {}, cwd: null, enabled: false, createdAt: 1,
      oauthClientId: null, oauthClientSecret: null, oauthScopes: null,
      authError: null, authErrorAt: null,
    });
    // The disabled flag was inert while every tool needed a per-project tick.
    // Leaking a disabled server's tools into every project is worse.
    expect(resolveSelection(selectionFor(registry, bb).snapshot(), "proj_a")).toEqual([]);
  });
});

describe("registration drift", () => {
  it("reports a description that moved after the name was registered", () => {
    const store = registry();
    store.replaceCatalog("echo", [row({ description: "Echo text" })]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    // What connecting an integration in Executor does: same tool, same
    // schema, new description. A sync writes it; nothing re-registers it.
    store.replaceCatalog("echo", [row({ description: "Echo text (now with integrations)" })]);
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    expect(driftedToolNames(bb, store.listTools())).toEqual(new Set(["echo"]));
  });

  it("reports a schema that moved, and stays quiet when nothing did", () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    const { bb } = fakeBb();
    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    expect(driftedToolNames(bb, store.listTools())).toEqual(new Set());

    store.replaceCatalog("echo", [row({
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    })]);
    expect(driftedToolNames(bb, store.listTools())).toEqual(new Set(["echo"]));
  });

  it("says nothing about a name this load never registered", () => {
    const store = registry();
    store.replaceCatalog("echo", [row()]);
    const { bb } = fakeBb();

    // No registerCatalogTools call: there is no frozen shape to drift from,
    // and claiming drift here would send the user to a reload that fixes
    // nothing.
    expect(driftedToolNames(bb, store.listTools())).toEqual(new Set());
  });
});

describe("gateway descriptions", () => {
  const gatewayDescription = [
    "Execute TypeScript in a sandboxed runtime.",
    "",
    "## Available integrations",
    "",
    "- `grafana_mcp`",
    "- `notion_com`",
    "- `notion_private_mcp`",
    "- `slack_com`",
  ].join("\n");

  it("gives the model a service name a word search can find", () => {
    const store = registry();
    store.replaceCatalog("echo", [row({ description: gatewayDescription })]);
    const { bb, registered } = fakeBb();

    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    // The slugs alone are the bug: a provider that matches whole words never
    // reaches `notion_com` from a query for "notion".
    expect(registered[0].description).toContain(gatewayDescription);
    expect(registered[0].description).toContain(
      "Reaches: grafana mcp, notion, notion private mcp, slack.",
    );
  });

  it("leaves an ordinary description exactly as its server wrote it", () => {
    const store = registry();
    store.replaceCatalog("echo", [row({
      description: "Echo text.\n\n- `text` is returned unchanged, see `getText`.",
    })]);
    const { bb, registered } = fakeBb();

    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    expect(registered[0].description).toBe(
      "Echo text.\n\n- `text` is returned unchanged, see `getText`.",
    );
  });

  it("reports no drift for a description it rewrote", () => {
    const store = registry();
    store.replaceCatalog("echo", [row({ description: gatewayDescription })]);
    const { bb } = fakeBb();

    registerCatalogTools(bb, { registry: store, execute: vi.fn() });

    expect(driftedToolNames(bb, store.listTools())).toEqual(new Set());
  });
});
