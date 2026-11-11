// bb-plugin-mcp-hub - the BB plugin backend entry.
//
// This file is wiring only. It opens the plugin's database, builds the MCP
// stack (registry -> stdio supervisor -> client pool -> catalog), registers
// the agent surfaces from the CACHED catalog, and exposes the registry over
// RPC. Nothing here touches an MCP server: the load path must never block on
// one, so discovery happens in `catalog.sync`, which runs from an explicit
// RPC or a background refresh.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MCP_CHANGED } from "./contract.js";
import { createCatalog } from "./src/catalog.js";
import { createClientPool } from "./src/mcp/client-pool.js";
import { createStdioSupervisor, loginShellPath } from "./src/mcp/stdio.js";
import { createHttpTransport, createStdioTransport } from "./src/mcp/transport.js";
import { discover } from "./src/oauth/discovery.js";
import { createOAuthFlow, type OAuthFlow } from "./src/oauth/flow.js";
import { registerCli } from "./src/server/cli.js";
import { createSelectionStore, registerConfigure } from "./src/server/configure.js";
import { quietLogger, warnQuietly } from "./src/server/log.js";
import { registerMcpEndpoint } from "./src/server/mcp-endpoint.js";
import { registerProviderEnv } from "./src/server/provider-env.js";
import { oauthRedirectUri, registerOAuthRoutes } from "./src/server/routes.js";
import { registerRpc } from "./src/server/rpc.js";
import { registerServices } from "./src/server/services.js";
import {
  createMcpExecutor,
  registerCatalogTools,
  registeredToolOwners,
} from "./src/server/tools.js";
import { createOAuthStore } from "./src/storage/oauth-store.js";
import { createRegistry } from "./src/storage/registry.js";
import { MCP_MIGRATIONS } from "./src/storage/schema.js";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const database = bb.storage.database();
  bb.storage.migrate(database, MCP_MIGRATIONS);
  const registry = createRegistry(database);

  // Every one of these can log from work that outlives the load - a scheduled
  // refresh, a client that fails long after the call that opened it - and a
  // stale `bb` handle throws on any member, so none of them gets `bb.log`.
  const log = quietLogger(bb);
  const stdio = createStdioSupervisor({ resolvePath: loginShellPath, log });
  const oauth: OAuthFlow = createOAuthFlow({
    store: createOAuthStore(database),
    discover,
    fetchImpl: fetch,
    // Read per call, never captured: `bb.server.loopbackBaseUrl` is
    // bind-gated and throws when read at factory scope.
    redirectUri: (origin) => oauthRedirectUri(bb, origin),
    // A dead grant has to be legible somewhere other than a log file: this is
    // what puts it in the panel, in `bb mcp-hub list`, and in the error an agent
    // gets back when it calls the tool.
    onAuthFailure: (serverId, message) => {
      registry.setAuthError(serverId, message);
      warnQuietly(bb, `MCP server "${serverId}" needs reconnecting: ${message}`);
      bb.realtime.publish(MCP_CHANGED, null);
      reportConfiguration();
    },
    onAuthRecovered: (serverId) => {
      registry.setAuthError(serverId, null);
      reportConfiguration();
    },
    // The server's own row, not a settings key. Which servers need a client
    // the user created themselves is open-ended - Slack, Google, a self-hosted
    // deployment, a second account for a service already configured - and a
    // settings schema is a fixed set of names. `null` here means "no manual
    // client saved", which is the flow's cue to try registration.
    staticClient: async (serverId) => {
      const server = registry.getServer(serverId);
      if (!server?.oauthClientId) return null;
      return {
        clientId: server.oauthClientId,
        clientSecret: server.oauthClientSecret,
      };
    },
    scopes: (serverId) => registry.getServer(serverId)?.oauthScopes ?? null,
    log,
  });
  const pool = createClientPool({
    createTransport: async (server, resolveAuthHeaders) =>
      server.transport === "stdio"
        ? createStdioTransport(server, stdio)
        : createHttpTransport(server, resolveAuthHeaders),
    // Resolved on every REQUEST, not once per connection: a pooled client can
    // outlive several access tokens, and `accessToken` refreshes at three
    // quarters of the quoted lifetime, so a token that went stale while the
    // client sat idle is renewed before the call that needed it. An
    // unauthenticated server simply has no tokens stored and gets no header.
    getAuthHeader: async (server): Promise<Record<string, string>> => {
      // The url, not just the id: a grant is bound to the host it was issued
      // for, and the slug survives a remove-and-re-add pointing elsewhere.
      const token = await oauth.accessToken(server.id, server.url ?? "");
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    log,
  });
  const catalog = createCatalog({
    registry,
    pool,
    log,
    // A server whose grant is gone answers 401 to everything. Without this it
    // is retried on every cycle forever, which is how four days of identical
    // failures ended up in a log with nobody told.
    needsReconnect: (serverId) => oauth.status(serverId) === "needs-reconnect",
  });

  /**
   * Marks the plugin as needing configuration while any server's credentials
   * are dead.
   *
   * `bb.status` is the only surface this plugin has that reaches a user who
   * does not have the panel open - it shows in `bb plugin list` and in the BB
   * UI. The SDK clears it on every load, so it is re-asserted from each place
   * that could have changed the answer rather than set once.
   */
  function reportConfiguration(): void {
    try {
      const broken = registry.listServers().filter((server) => server.authError !== null);
      if (broken.length === 0) return;
      bb.status.needsConfiguration(
        broken.length === 1
          ? `MCP server "${broken[0].displayName}" needs reconnecting in the MCP panel.`
          : `${broken.length} MCP servers need reconnecting in the MCP panel: `
            + broken.map((server) => server.displayName).join(", "),
      );
    } catch {
      // Called from background work that can outlive the load; a status line
      // is never worth taking the host down with.
    }
  }

  const execute = createMcpExecutor({
    registry, pool, stderrTail: (serverId) => stdio.stderrTail(serverId),
    // Only ever consulted for a `readOnly` tool: a write is never replayed.
    refreshAuth: (serverId) => oauth.refresh(serverId),
    // A 401 that outlives a refresh is the other way a grant turns out to
    // be dead. Recorded here so the panel says it too, rather than the only
    // record being an error one agent saw once.
    reportAuthFailure: (serverId, message) => {
      registry.setAuthError(serverId, message);
      bb.realtime.publish(MCP_CHANGED, null);
      reportConfiguration();
    },
    });
  const selection = createSelectionStore({
    registry,
    registeredOwners: () => registeredToolOwners(bb),
    log,
  });

  /**
   * Registers whatever the catalog gained and rebuilds the selection.
   * `registerTool` works after load, so a sync adds tools live and they reach
   * a thread when its provider session is next constructed - never a reload,
   * which would cancel every pending interaction on every thread.
   */
  const onCatalogChanged = (): void => {
    registerCatalogTools(bb, { registry, execute });
    selection.refresh();
  };

  onCatalogChanged();
  reportConfiguration();
  registerConfigure(bb, {
    selection: () => selection.snapshot(),
  });
  // The fallback callback, for a shell with no http(s) origin to redirect to.
  // A browser that has one lands on the panel instead and completes the
  // exchange over the authenticated `oauth_complete` RPC; this route is
  // unauthenticated by necessity, since a redirect from the authorization
  // server carries no BB origin and no plugin token, and the single-use
  // `state` nonce is all that stands in for both.
  registerOAuthRoutes(bb, {
    flow: oauth,
    onConnected: (serverId) => {
      registry.setAuthError(serverId, null);
      reportConfiguration();
      // A freshly authorized server has a catalog worth reading, and the
      // callback's browser tab is not somewhere to wait for it.
      void catalog
        .sync(serverId)
        .then(() => { onCatalogChanged(); })
        .catch((error: unknown) => {
          warnQuietly(
            bb,
            `Connected MCP server "${serverId}" but could not read its tools: ${String(error)}`,
          );
        });
    },
  });
  registerRpc(bb, {
    registry,
    catalog,
    pool,
    oauth,
    onAuthChanged: reportConfiguration,
    stderrTail: (serverId) => stdio.stderrTail(serverId),
    onCatalogChanged,
    onSelectionChanged: () => { selection.refresh(); },
    dropClient: (serverId) => pool.close(serverId),
  });
  // Ask-flagged tools never reach this: it has no thread to prompt in.
  registerMcpEndpoint(bb, { registry, execute });
  registerCli(bb, { registry });
  registerProviderEnv(bb);
  registerServices(bb, {
    catalog,
    onCatalogChanged,
    // Run before the catalog sweep so a grant that died overnight is
    // discovered - and recorded - by the background pass rather than by the
    // first tool call of the morning.
    warmTokens: async () => {
      for (const server of registry.listServers()) {
        if (server.transport !== "http" || server.url === null) continue;
        await oauth.accessToken(server.id, server.url);
      }
    },
  });

  // Dispose hooks run before BB drains in-flight invocations, so this is the
  // only place that reliably reaps MCP clients and stdio children.
  bb.onDispose(async () => {
    await pool.closeAll();
    await stdio.killAll();
  });
}
