import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isHeaderAuthenticated,
  MCP_CHANGED,
  type McpAuthStatus,
  type McpProjectDto,
  type McpServerDto,
  type McpToolDto,
  rpcContract,
  transportForKind,
} from "../../contract.js";
import type { Catalog } from "../catalog.js";
import { warnQuietly } from "./log.js";
import { describeParameters } from "./tool-details.js";
import { driftedToolNames } from "./tools.js";
import type { CatalogTool, Registry, ServerRecord } from "../storage/registry.js";

/**
 * Derives a server's id from its display name: lowercase, every run of
 * non-alphanumeric characters becomes one dash.
 *
 * The id is what prefixes a colliding tool name and what bindings are keyed
 * on, so it has to be stable and readable. Deriving it means the user never
 * types it and the two can never disagree.
 */
export function slugifyServerId(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toServerDto(
  record: ServerRecord,
  authStatus: McpAuthStatus | null,
  registeredRedirectUri: string | null,
): McpServerDto {
  return {
    id: record.id,
    displayName: record.displayName,
    transport: record.transport,
    kind: record.kind,
    url: record.url,
    command: record.command,
    args: record.args,
    env: record.env,
    cwd: record.cwd,
    headers: record.headers,
    enabled: record.enabled,
    createdAt: record.createdAt,
    authStatus,
    oauthClientId: record.oauthClientId,
    // Whether one is stored, never the secret itself: this DTO is the payload
    // of every panel render, and a secret in it is a secret in every network
    // log that ever captured one.
    hasOauthClientSecret: record.oauthClientSecret !== null
      && record.oauthClientSecret !== "",
    oauthScopes: record.oauthScopes,
    authError: record.authError === null
      ? null
      : { message: record.authError, at: record.authErrorAt ?? 0 },
    registeredRedirectUri,
  };
}

/**
 * Characters per token, for the panel's cost estimate.
 *
 * Calibrated against this database rather than guessed. The 42 Notion tools
 * catalogued here total 197,377 characters of name + description + schema,
 * which at 4 is ~49k tokens. Design section 8b measured four connectors
 * (Notion, Gmail, Calendar, Drive) at ~71k tokens of schema, and Notion is by
 * far the largest of those four, so ~49k for Notion alone fits. A divisor of
 * 3.5 would claim ~56k for Notion and leave ~15k for the other three, which
 * does not.
 *
 * What the estimate ignores, deliberately: the JSON wrapper a provider puts
 * around each tool, and Claude Code's 16-character `mcp__bb-bridge__` name
 * prefix. Both are small beside a schema, and there is no public tokeniser for
 * Claude that would do better. The number is an approximation and is always
 * rendered with a `~`.
 */
const CHARS_PER_TOKEN = 4;

function toToolDto(row: CatalogTool, drifted: ReadonlySet<string>): McpToolDto {
  // What a provider actually ships for a tool: the name it is registered
  // under, the description, and the serialised input schema.
  const schema = JSON.stringify(row.inputSchema);
  return {
    serverId: row.serverId,
    upstreamName: row.upstreamName,
    registeredName: row.registeredName,
    description: row.description,
    readOnly: row.readOnly,
    defaultEnabled: row.defaultEnabled,
    stale: row.stale,
    driftedFromRegistration: drifted.has(row.registeredName),
    syncedAt: row.syncedAt,
    // What a tool actually costs a thread is its schema, so the panel shows
    // the size rather than the schema itself (design section 8b).
    schemaBytes: Buffer.byteLength(schema, "utf8"),
    estimatedTokens: Math.ceil(
      (row.registeredName.length + row.description.length + schema.length)
      / CHARS_PER_TOKEN,
    ),
  };
}

export interface RpcDeps {
  registry: Registry;
  catalog: Catalog;
  /**
   * Structural rather than the whole `ClientPool`: this file only ever
   * connects to a server to see whether connecting works.
   */
  pool: { listTools(server: ServerRecord): Promise<unknown[]> };
  oauth: {
    begin(
      serverId: string,
      resourceUrl: string,
      redirectOrigin?: string,
    ): Promise<{ authorizeUrl: string }>;
    complete(state: string, code: string): Promise<{ serverId: string }>;
    status(serverId: string): McpAuthStatus;
    /** Destroy every credential stored for a server that is being removed. */
    forget(serverId: string): void;
    /** The redirect URI the stored client was registered with, if any. */
    registeredRedirectUri(serverId: string): string | null;
  };
  /** The stdio child's last 100 stderr lines, empty for a remote server. */
  stderrTail(serverId: string): string[];
  /**
   * The catalog or the server list changed: register whatever is newly
   * discovered and rebuild the selection snapshot.
   */
  onCatalogChanged(): void;
  /**
   * A binding or a global default moved, so the selection snapshot is stale.
   *
   * Takes no project: a default change moves EVERY project's selection at
   * once, and there is no list of the projects it reached.
   */
  onSelectionChanged(): void;
  /**
   * Drop the pooled client for a server, closing its connection and reaping a
   * stdio child. Called when the server is gone, and when its configuration
   * changed in a way a live connection cannot pick up.
   */
  dropClient(serverId: string): Promise<void>;
  /**
   * A server's credentials just started or stopped working, so the plugin's
   * `needs-configuration` line may no longer be true.
   */
  onAuthChanged(): void;
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const changed = (): void => {
    bb.realtime.publish(MCP_CHANGED, null);
  };

  /**
   * A stdio server has no OAuth, so it has no status; reporting one would
   * invite the panel to render "disconnected" next to a server that is
   * working perfectly.
   */
  const describe = (record: ServerRecord): McpServerDto =>
    toServerDto(
      record,
      record.transport === "http" ? deps.oauth.status(record.id) : null,
      record.transport === "http" ? deps.oauth.registeredRedirectUri(record.id) : null,
    );

  const requireServer = (id: string): ServerRecord => {
    const server = deps.registry.getServer(id);
    if (server === undefined) throw new Error(`No MCP server with id "${id}"`);
    return server;
  };

  bb.rpc.register(rpcContract, {
    servers_list: () => ({ servers: deps.registry.listServers().map(describe) }),

    servers_add: (input) => {
      const id = slugifyServerId(input.displayName);
      if (id === "") {
        throw new Error(
          `"${input.displayName}" has no letters or digits to build a server id from`,
        );
      }
      if (deps.registry.getServer(id) !== undefined) {
        // Upserting here would silently overwrite another server's command
        // and url while leaving its catalog and bindings pointing at the new
        // one.
        throw new Error(`An MCP server with id "${id}" already exists`);
      }
      const record: ServerRecord = {
        id,
        displayName: input.displayName,
        kind: input.kind,
        // Derived, never asked for: "a gateway" and "a remote MCP server" are
        // different answers to the user's question and the same answer to the
        // wire's.
        transport: transportForKind(input.kind),
        url: input.url ?? null,
        command: input.command ?? null,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd ?? null,
        headers: input.headers ?? {},
        enabled: true,
        createdAt: Date.now(),
        oauthClientId: input.oauthClientId ?? null,
        oauthClientSecret: input.oauthClientSecret ?? null,
        oauthScopes: input.oauthScopes ?? null,
        authError: null,
        authErrorAt: null,
      };
      deps.registry.upsertServer(record);
      changed();
      return { server: describe(record) };
    },

    servers_set_oauth_client: (input) => {
      const server = requireServer(input.id);
      if (server.transport !== "http") {
        throw new Error(
          `MCP server "${server.id}" is a stdio server: it runs as a local child `
          + "process and has nothing to authorize.",
        );
      }
      deps.registry.setServerOAuthClient(input.id, {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: input.scopes,
      });
      // The grant goes with the client. A token minted for another client id,
      // or for a narrower set of scopes, is not one this configuration can go
      // on using, and leaving it would let the panel report "connected" over
      // credentials the server has already stopped honouring. `begin` guards
      // the same invariant itself, so it does not rest on this call.
      deps.oauth.forget(input.id);
      changed();
      return { ok: true };
    },

    servers_set_headers: async (input) => {
      const server = requireServer(input.id);
      if (server.transport !== "http") {
        throw new Error(
          `MCP server "${server.id}" is a stdio server: it sends no requests, so `
          + "its configuration belongs in env.",
        );
      }
      deps.registry.setServerHeaders(input.id, input.headers);
      // Streamable HTTP bakes its headers into the transport at construction,
      // so the pooled client would go on sending the old set - including a
      // header the user just deleted - until something else happened to drop
      // it.
      await deps.dropClient(input.id);
      changed();
      return { ok: true };
    },

    servers_set_enabled: async (input) => {
      requireServer(input.id);
      deps.registry.setServerEnabled(input.id, input.enabled);
      // A switched-off server should not keep a live connection open.
      if (!input.enabled) await deps.dropClient(input.id);
      deps.onCatalogChanged();
      changed();
      return { ok: true };
    },

    servers_remove: async (input) => {
      const existed = deps.registry.getServer(input.id) !== undefined;
      // Cascades to this server's catalog rows and their bindings. The tool
      // names stay registered - there is no unregisterTool - but their
      // execute now reports the server as gone.
      deps.registry.deleteServer(input.id);
      // Credentials are not part of that cascade and nothing else can reach
      // them: a removed server's plaintext access and refresh tokens would
      // otherwise sit in the database forever, and the next server to take
      // this slug would inherit them.
      deps.oauth.forget(input.id);
      await deps.dropClient(input.id);
      deps.onCatalogChanged();
      changed();
      return { removed: existed };
    },

    servers_connect: async (input) => {
      const server = requireServer(input.id);
      if (server.transport !== "http" || server.url === null) {
        throw new Error(
          `MCP server "${server.id}" is a stdio server: it runs as a local child `
          + "process and has nothing to authorize.",
        );
      }
      // A server already carrying its own Authorization header has nothing to
      // connect, and the flow cannot fail politely: discovery falls back to
      // conventional endpoints on the resource's origin, so a host that serves
      // a single-page app answers `/register` with its index page and a 200.
      if (isHeaderAuthenticated(server)) {
        throw new Error(
          `MCP server "${server.id}" authenticates with an Authorization header, `
          + "so there is no OAuth grant to start. Edit the token under Headers, "
          + "or clear it and configure an OAuth client to use OAuth instead.",
        );
      }
      // A server that needs no sign-in (grep.app, DeepWiki, Context7) has no
      // OAuth to begin, and the flow would fail on it: discovery finds nothing
      // and dynamic client registration answers 404. So ask it for its tools
      // first. An answer means it is open: read its catalog and stop there. A
      // refusal, or an empty answer, is the ordinary sign-in case, and falls
      // through to the flow exactly as before.
      try {
        const tools = await deps.pool.listTools(server);
        if (tools.length > 0) {
          await deps.catalog.sync(server.id);
          deps.registry.setAuthError(server.id, null);
          deps.onCatalogChanged();
          changed();
          return { authorizeUrl: null };
        }
      } catch {
        // Needs credentials; the OAuth flow below is the answer.
      }
      // Returned, never opened. The backend has no browser, and a URL the
      // panel navigates to is one the user can also see before following.
      return deps.oauth.begin(server.id, server.url, input.redirectOrigin);
    },

    oauth_complete: async (input) => {
      const { serverId } = await deps.oauth.complete(input.state, input.code);
      // A grant that was just issued is a grant that works, whatever was
      // recorded about the last one.
      deps.registry.setAuthError(serverId, null);
      deps.onAuthChanged();
      // The old client is carrying either no credentials or dead ones.
      await deps.dropClient(serverId);
      const server = deps.registry.getServer(serverId);
      // Read now and registered now: a freshly authorized server has a
      // catalog worth having, and the panel is waiting on this call.
      try {
        await deps.catalog.sync(serverId);
        deps.onCatalogChanged();
      } catch (error) {
        // Not fatal: the connection succeeded, which is what was asked for.
        // The panel's Sync button is right there for the rest.
        warnQuietly(
          bb,
          `Connected MCP server "${serverId}" but could not read its tools: ${String(error)}`,
        );
      }
      changed();
      return { serverId, displayName: server?.displayName ?? serverId };
    },

    plugin_reload: () => {
      // After the response, never during it: reloading disposes this handler's
      // own plugin instance, and a reply that never left is a panel stuck on a
      // spinner with no way to know the reload it asked for did happen.
      setTimeout(() => {
        void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch(() => {
          // The panel has already been told the request was accepted, and a
          // stale handle here cannot report anything to anyone.
        });
      }, 0);
      return { ok: true };
    },

    servers_test: async (input) => {
      const server = requireServer(input.id);
      try {
        const tools = await deps.pool.listTools(server);
        return {
          ok: true, toolCount: tools.length, error: null,
          // Reported even on success: a server can start, warn about a
          // deprecated flag or a missing optional credential, and still work.
          stderr: deps.stderrTail(server.id),
        };
      } catch (error) {
        // Never rethrown. The failure IS the answer here, and the stderr tail
        // that explains it only reaches the panel through a resolved call.
        return {
          ok: false, toolCount: 0, error: String(error),
          stderr: deps.stderrTail(server.id),
        };
      }
    },

    catalog_sync: async (input) => {
      const added = await deps.catalog.sync(input.serverId);
      deps.onCatalogChanged();
      changed();
      return {
        added,
        total: deps.registry.listTools(input.serverId).filter((row) => !row.stale).length,
      };
    },

    tools_list: (input) => {
      const rows = deps.registry.listTools(input.serverId);
      const drifted = driftedToolNames(bb, rows);
      return { tools: rows.map((row) => toToolDto(row, drifted)) };
    },

    tool_details: (input) => {
      const row = deps.registry.getToolByRegisteredName(input.registeredName);
      if (row === undefined) {
        throw new Error(`No tool named "${input.registeredName}"`);
      }
      return {
        tool: {
          registeredName: row.registeredName,
          description: row.description,
          parameters: describeParameters(row.inputSchema),
          inputSchema: JSON.stringify(row.inputSchema, null, 2),
        },
      };
    },

    bindings_list: (input) => ({
      overrides: deps.registry
        .listBindingStates()
        .filter((binding) => binding.projectId === input.projectId)
        .map((binding) => ({
          registeredName: binding.registeredName, enabled: binding.enabled,
        })),
    }),

    binding_set: (input) => {
      // An unknown name is accepted on purpose: the panel can bind a tool
      // before its server is synced, and the selection snapshot drops names
      // that are not registered rather than letting one bad row reject the
      // project's whole selection.
      if (input.state === "inherit") {
        deps.registry.clearBinding(input.projectId, input.registeredName);
      } else {
        deps.registry.setBinding(input.projectId, input.registeredName, input.state === "on");
      }
      deps.onSelectionChanged();
      changed();
      return { ok: true };
    },

    tools_set_default: (input) => {
      // Names, not (serverId, upstreamName) pairs: the panel and the CLI both
      // speak registered names, and resolving here keeps the pair - which only
      // the storage layer keys on - out of the wire contract. An unknown name
      // is skipped for the same reason `binding_set` tolerates one.
      const wanted = new Set(input.registeredNames);
      const tools = deps.registry
        .listTools()
        .filter((row) => wanted.has(row.registeredName))
        .map((row) => ({ serverId: row.serverId, upstreamName: row.upstreamName }));
      const updated = deps.registry.setToolDefaults(tools, input.defaultEnabled);
      deps.onSelectionChanged();
      changed();
      return { updated };
    },

    projects_list: async () => {
      // `includePersonal` is explicit: every personal thread shares one
      // project (design section 8), and leaving it to the default would drop
      // the project most users want their MCP tools in.
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((project): McpProjectDto => ({
          id: project.id,
          name: project.name,
          personal: project.kind === "personal",
        })),
      };
    },
  });
}
