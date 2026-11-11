import type Database from "better-sqlite3";

export type Transport = "stdio" | "http";

/**
 * What the user said this connection is, as opposed to how it is spoken to.
 *
 * Deliberately not the same axis as {@link Transport}, which stays the wire
 * fact. `kind` is what the panel asks for and labels a row with: a gateway and
 * an ordinary remote server are both Streamable HTTP, but they are not the
 * same thing to a person deciding what to add. Nothing branches on it - a
 * gateway is still DETECTED from its tool descriptions (see server/gateway.ts)
 * - so a row carrying the wrong kind is cosmetic, never a behaviour change.
 */
export type ServerKind = "local" | "remote" | "gateway";

/** The kind an older row means, for one written before the column existed. */
export function kindFromTransport(transport: Transport): ServerKind {
  return transport === "stdio" ? "local" : "remote";
}

/** The transport a kind is spoken over. A gateway is a remote server. */
export function transportForKind(kind: ServerKind): Transport {
  return kind === "local" ? "stdio" : "http";
}

export interface ServerRecord {
  id: string; // slug, [a-z0-9-]+
  displayName: string;
  transport: Transport;
  /** Presentation only; see {@link ServerKind}. */
  kind: ServerKind;
  url: string | null; // http only
  command: string | null; // stdio only
  args: string[]; // stdio only
  env: Record<string, string>; // stdio only
  cwd: string | null; // stdio only
  /**
   * Extra headers sent on every request, http only.
   *
   * Where a static API token goes for a server that does not speak OAuth -
   * the same job `env` does for a stdio server, which is why it is stored the
   * same way and kept in full rather than write-only.
   */
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  /**
   * An OAuth client the user created themselves, for a server that does not
   * do Dynamic Client Registration. `null` means "try registration".
   *
   * Per server rather than per plugin because the set of servers needing one
   * is open-ended - Slack, Google, anything self-hosted, a second account for
   * a service already configured - and a settings key is a fixed name.
   */
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  /**
   * The scope string exactly as the user typed it. Split and re-joined only
   * when the authorize URL is built, so what the panel shows back is what was
   * entered rather than this code's idea of it.
   */
  oauthScopes: string | null;
  /**
   * Why this server's credentials stopped working, or `null` while they work.
   *
   * Written when a refresh is refused outright or a 401 survives one, and
   * cleared by any successful exchange. It exists because `authStatus` alone
   * says only THAT a server needs reconnecting - never why, and never anywhere
   * a user who does not have the panel open would see it.
   */
  authError: string | null;
  authErrorAt: number | null;
}

export interface CatalogTool {
  serverId: string;
  upstreamName: string;
  registeredName: string; // persisted at first sync, never reassigned
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean; // from annotations.readOnlyHint, default false
  /**
   * Available in every project that has not overridden it off.
   *
   * A per-project binding is the only way a tool becomes visible otherwise,
   * so a user who wants one tool everywhere has to tick it once per project
   * and again for every project they later create.
   */
  defaultEnabled: boolean;
  stale: boolean;
  syncedAt: number;
}

export interface Registry {
  listServers(): ServerRecord[];
  getServer(id: string): ServerRecord | undefined;
  upsertServer(record: ServerRecord): void;
  /**
   * Writes the manually created OAuth client for one server.
   *
   * A `null` field leaves the stored value alone; an empty string clears it.
   * The distinction exists for the secret: the panel is never told the secret,
   * so it cannot send one back, and without this re-saving an edited client id
   * would silently wipe the secret that id is useless without. The id and the
   * scopes follow the same rule so one sentence describes the whole method.
   */
  setServerOAuthClient(
    id: string,
    client: { clientId: string | null; clientSecret: string | null; scopes: string | null },
  ): void;
  /** Replaces the whole header map: an absent header is one that was deleted. */
  setServerHeaders(id: string, headers: Record<string, string>): void;
  /** Switches a whole server on or off without touching its catalog or credentials. */
  setServerEnabled(id: string, enabled: boolean): void;
  /**
   * Records why this server's credentials stopped working, or clears it with
   * `null`. Idempotent: the same message written twice does not move the
   * timestamp, so "since when" keeps meaning something across a cron that
   * re-discovers the same dead grant every seventeen minutes.
   */
  setAuthError(id: string, message: string | null): void;
  deleteServer(id: string): void;
  listTools(serverId?: string): CatalogTool[];
  getToolByRegisteredName(name: string): CatalogTool | undefined;
  replaceCatalog(serverId: string, tools: CatalogTool[]): void; // marks missing stale
  /** Returns how many rows the flag actually moved. */
  setToolDefaults(
    tools: Array<{ serverId: string; upstreamName: string }>,
    defaultEnabled: boolean,
  ): number;
  listBindings(projectId: string): string[]; // enabled registeredNames
  /** Every override row, for every project: the on ones and the off ones. */
  listBindingStates(): Array<{ projectId: string; registeredName: string; enabled: boolean }>;
  setBinding(projectId: string, registeredName: string, enabled: boolean): void;
  /** Drop the override, so the tool follows its global default again. */
  clearBinding(projectId: string, registeredName: string): void;
  prune(validProjectIds: Set<string>): void;
}

interface ServerRow {
  id: string;
  display_name: string;
  transport: string;
  kind: string;
  url: string | null;
  command: string | null;
  args: string;
  env: string;
  cwd: string | null;
  headers: string;
  enabled: number;
  created_at: number;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string | null;
  auth_error: string | null;
  auth_error_at: number | null;
}

interface ToolRow {
  server_id: string;
  upstream_name: string;
  registered_name: string;
  description: string;
  input_schema: string;
  read_only: number;
  default_enabled: number;
  stale: number;
  synced_at: number;
}

function serverFromRow(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    transport: row.transport as Transport,
    // An empty column is a row written before the kind existed; the transport
    // is what it meant.
    kind: row.kind === "" ? kindFromTransport(row.transport as Transport) : row.kind as ServerKind,
    url: row.url,
    command: row.command,
    args: JSON.parse(row.args) as string[],
    env: JSON.parse(row.env) as Record<string, string>,
    cwd: row.cwd,
    headers: JSON.parse(row.headers) as Record<string, string>,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    oauthClientId: row.oauth_client_id,
    oauthClientSecret: row.oauth_client_secret,
    oauthScopes: row.oauth_scopes,
    authError: row.auth_error,
    authErrorAt: row.auth_error_at,
  };
}

function toolFromRow(row: ToolRow): CatalogTool {
  return {
    serverId: row.server_id,
    upstreamName: row.upstream_name,
    registeredName: row.registered_name,
    description: row.description,
    inputSchema: JSON.parse(row.input_schema) as Record<string, unknown>,
    readOnly: row.read_only === 1,
    defaultEnabled: row.default_enabled === 1,
    stale: row.stale === 1,
    syncedAt: row.synced_at,
  };
}

export function createRegistry(db: Database.Database): Registry {
  const listServersStmt = db.prepare("SELECT * FROM servers ORDER BY id");
  const getServerStmt = db.prepare("SELECT * FROM servers WHERE id = ?");
  const upsertServerStmt = db.prepare(`
    INSERT INTO servers (
      id, display_name, transport, kind, url, command, args, env, cwd, headers,
      enabled, created_at, oauth_client_id, oauth_client_secret, oauth_scopes
    )
    VALUES (
      @id, @displayName, @transport, @kind, @url, @command, @args, @env, @cwd, @headers,
      @enabled, @createdAt, @oauthClientId, @oauthClientSecret, @oauthScopes
    )
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      transport = excluded.transport,
      kind = excluded.kind,
      url = excluded.url,
      command = excluded.command,
      args = excluded.args,
      env = excluded.env,
      cwd = excluded.cwd,
      headers = excluded.headers,
      enabled = excluded.enabled,
      created_at = excluded.created_at,
      oauth_client_id = excluded.oauth_client_id,
      oauth_client_secret = excluded.oauth_client_secret,
      oauth_scopes = excluded.oauth_scopes
  `);
  // COALESCE, not excluded: a null field means "leave this one alone". The
  // panel never receives the secret, so a save that carried a null through as
  // an overwrite would destroy it every time the client id was edited.
  const setServerOAuthClientStmt = db.prepare(`
    UPDATE servers SET
      oauth_client_id = COALESCE(@clientId, oauth_client_id),
      oauth_client_secret = COALESCE(@clientSecret, oauth_client_secret),
      oauth_scopes = COALESCE(@scopes, oauth_scopes)
    WHERE id = @id
  `);
  const setServerHeadersStmt = db.prepare(
    "UPDATE servers SET headers = @headers WHERE id = @id",
  );
  const setServerEnabledStmt = db.prepare(
    "UPDATE servers SET enabled = @enabled WHERE id = @id",
  );
  // The `auth_error IS NOT @message` guard is what keeps `auth_error_at`
  // meaning "since when": the background refresh rediscovers the same dead
  // grant on every cycle, and a timestamp bumped each time would report a
  // four-day outage as a brand new one.
  const setAuthErrorStmt = db.prepare(`
    UPDATE servers SET
      auth_error = @message,
      auth_error_at = CASE WHEN @message IS NULL THEN NULL
        WHEN auth_error IS NOT @message THEN @at ELSE auth_error_at END
    WHERE id = @id
  `);
  const deleteServerStmt = db.prepare("DELETE FROM servers WHERE id = ?");
  const listRegisteredNamesForServerStmt = db.prepare(
    "SELECT registered_name FROM tools WHERE server_id = ?",
  );
  const deleteToolsForServerStmt = db.prepare("DELETE FROM tools WHERE server_id = ?");
  const deleteBindingsByRegisteredNameStmt = db.prepare(
    "DELETE FROM bindings WHERE registered_name = ?",
  );

  const listToolsAllStmt = db.prepare("SELECT * FROM tools ORDER BY server_id, upstream_name");
  const listToolsForServerStmt = db.prepare(
    "SELECT * FROM tools WHERE server_id = ? ORDER BY upstream_name",
  );
  const getToolByRegisteredNameStmt = db.prepare(
    "SELECT * FROM tools WHERE registered_name = ?",
  );
  const listUpstreamNamesForServerStmt = db.prepare(
    "SELECT upstream_name FROM tools WHERE server_id = ?",
  );
  const upsertToolStmt = db.prepare(`
    INSERT INTO tools (
      server_id, upstream_name, registered_name, description, input_schema,
      read_only, default_enabled, stale, synced_at
    )
    VALUES (
      @serverId, @upstreamName, @registeredName, @description, @inputSchema,
      @readOnly, @defaultEnabled, @stale, @syncedAt
    )
    -- registered_name and default_enabled are inserted but never updated:
    -- both are the user's, not the server's. Updating the default here would
    -- let every catalog sync overwrite the choice with whatever the caller
    -- happened to pass, which is the drift a re-derived default used to cause.
    ON CONFLICT(server_id, upstream_name) DO UPDATE SET
      description = excluded.description,
      input_schema = excluded.input_schema,
      read_only = excluded.read_only,
      stale = excluded.stale,
      synced_at = excluded.synced_at
  `);
  const markStaleStmt = db.prepare(
    "UPDATE tools SET stale = 1 WHERE server_id = ? AND upstream_name = ?",
  );
  const setToolDefaultStmt = db.prepare(
    "UPDATE tools SET default_enabled = ? WHERE server_id = ? AND upstream_name = ?",
  );

  const listBindingsStmt = db.prepare(
    "SELECT registered_name FROM bindings WHERE project_id = ? AND enabled = 1 ORDER BY registered_name",
  );
  const upsertBindingStmt = db.prepare(`
    INSERT INTO bindings (project_id, registered_name, enabled)
    VALUES (@projectId, @registeredName, @enabled)
    ON CONFLICT(project_id, registered_name) DO UPDATE SET enabled = excluded.enabled
  `);
  const listBindingStatesStmt = db.prepare(
    "SELECT project_id, registered_name, enabled FROM bindings ORDER BY project_id, registered_name",
  );
  const deleteBindingStmt = db.prepare(
    "DELETE FROM bindings WHERE project_id = ? AND registered_name = ?",
  );
  const listBindingProjectIdsStmt = db.prepare(
    "SELECT DISTINCT project_id FROM bindings",
  );
  const deleteBindingsForProjectStmt = db.prepare(
    "DELETE FROM bindings WHERE project_id = ?",
  );

  const replaceCatalogTx = db.transaction((serverId: string, tools: CatalogTool[]) => {
    const incomingUpstreamNames = new Set(tools.map((tool) => tool.upstreamName));

    for (const tool of tools) {
      upsertToolStmt.run({
        serverId: tool.serverId,
        upstreamName: tool.upstreamName,
        registeredName: tool.registeredName,
        description: tool.description,
        inputSchema: JSON.stringify(tool.inputSchema),
        readOnly: tool.readOnly ? 1 : 0,
        defaultEnabled: tool.defaultEnabled ? 1 : 0,
        // replaceCatalog's contract is "this IS the current catalog" -- every
        // incoming row is fresh by definition, so freshness is enforced here
        // rather than trusting the caller's `stale` field.
        stale: 0,
        syncedAt: tool.syncedAt,
      });
    }

    const existingUpstreamNames = listUpstreamNamesForServerStmt
      .all(serverId) as { upstream_name: string }[];
    for (const row of existingUpstreamNames) {
      if (!incomingUpstreamNames.has(row.upstream_name)) {
        markStaleStmt.run(serverId, row.upstream_name);
      }
    }
  });

  // One transaction for the whole set: the bulk toggle in the panel is a
  // single user action, and half of it landing would leave the panel showing
  // a state no click produced.
  const setToolDefaultsTx = db.transaction(
    (tools: Array<{ serverId: string; upstreamName: string }>, defaultEnabled: boolean): number => {
      let updated = 0;
      for (const tool of tools) {
        updated += setToolDefaultStmt
          .run(defaultEnabled ? 1 : 0, tool.serverId, tool.upstreamName).changes;
      }
      return updated;
    },
  );

  const deleteServerTx = db.transaction((id: string) => {
    const registeredNames = listRegisteredNamesForServerStmt
      .all(id) as { registered_name: string }[];
    for (const row of registeredNames) {
      deleteBindingsByRegisteredNameStmt.run(row.registered_name);
    }
    deleteToolsForServerStmt.run(id);
    deleteServerStmt.run(id);
  });

  return {
    listServers(): ServerRecord[] {
      return (listServersStmt.all() as ServerRow[]).map(serverFromRow);
    },

    getServer(id: string): ServerRecord | undefined {
      const row = getServerStmt.get(id) as ServerRow | undefined;
      return row ? serverFromRow(row) : undefined;
    },

    upsertServer(record: ServerRecord): void {
      upsertServerStmt.run({
        id: record.id,
        displayName: record.displayName,
        transport: record.transport,
        kind: record.kind,
        url: record.url,
        command: record.command,
        args: JSON.stringify(record.args),
        env: JSON.stringify(record.env),
        cwd: record.cwd,
        headers: JSON.stringify(record.headers),
        enabled: record.enabled ? 1 : 0,
        createdAt: record.createdAt,
        oauthClientId: record.oauthClientId,
        oauthClientSecret: record.oauthClientSecret,
        oauthScopes: record.oauthScopes,
      });
    },

    setServerOAuthClient(
      id: string,
      client: { clientId: string | null; clientSecret: string | null; scopes: string | null },
    ): void {
      setServerOAuthClientStmt.run({
        id,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        scopes: client.scopes,
      });
    },

    setServerHeaders(id: string, headers: Record<string, string>): void {
      setServerHeadersStmt.run({ id, headers: JSON.stringify(headers) });
    },

    setServerEnabled(id: string, enabled: boolean): void {
      setServerEnabledStmt.run({ id, enabled: enabled ? 1 : 0 });
    },

    setAuthError(id: string, message: string | null): void {
      setAuthErrorStmt.run({ id, message, at: Date.now() });
    },

    deleteServer(id: string): void {
      deleteServerTx(id);
    },

    listTools(serverId?: string): CatalogTool[] {
      const rows = (
        serverId ? listToolsForServerStmt.all(serverId) : listToolsAllStmt.all()
      ) as ToolRow[];
      return rows.map(toolFromRow);
    },

    getToolByRegisteredName(name: string): CatalogTool | undefined {
      const row = getToolByRegisteredNameStmt.get(name) as ToolRow | undefined;
      return row ? toolFromRow(row) : undefined;
    },

    replaceCatalog(serverId: string, tools: CatalogTool[]): void {
      replaceCatalogTx(serverId, tools);
    },

    setToolDefaults(
      tools: Array<{ serverId: string; upstreamName: string }>,
      defaultEnabled: boolean,
    ): number {
      return setToolDefaultsTx(tools, defaultEnabled);
    },

    listBindings(projectId: string): string[] {
      const rows = listBindingsStmt.all(projectId) as { registered_name: string }[];
      return rows.map((row) => row.registered_name);
    },

    listBindingStates(): Array<{ projectId: string; registeredName: string; enabled: boolean }> {
      const rows = listBindingStatesStmt.all() as {
        project_id: string; registered_name: string; enabled: number;
      }[];
      return rows.map((row) => ({
        projectId: row.project_id,
        registeredName: row.registered_name,
        enabled: row.enabled === 1,
      }));
    },

    setBinding(projectId: string, registeredName: string, enabled: boolean): void {
      upsertBindingStmt.run({
        projectId,
        registeredName,
        enabled: enabled ? 1 : 0,
      });
    },

    clearBinding(projectId: string, registeredName: string): void {
      deleteBindingStmt.run(projectId, registeredName);
    },

    prune(validProjectIds: Set<string>): void {
      const rows = listBindingProjectIdsStmt.all() as { project_id: string }[];
      for (const row of rows) {
        if (!validProjectIds.has(row.project_id)) {
          deleteBindingsForProjectStmt.run(row.project_id);
        }
      }
    },
  };
}
