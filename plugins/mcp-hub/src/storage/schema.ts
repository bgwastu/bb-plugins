// Append-only list of raw SQL migration statements. `bb.storage.migrate`
// treats each array index as the migration id, so existing entries must
// never be edited or reordered -- only append new statements.
export const MCP_MIGRATIONS: string[] = [
  `
  CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    transport TEXT NOT NULL,
    url TEXT,
    command TEXT,
    args TEXT NOT NULL,
    env TEXT NOT NULL,
    cwd TEXT,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE tools (
    server_id TEXT NOT NULL,
    upstream_name TEXT NOT NULL,
    registered_name TEXT NOT NULL,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    read_only INTEGER NOT NULL,
    ask INTEGER NOT NULL,
    stale INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, upstream_name)
  );
  `,
  `
  CREATE UNIQUE INDEX tools_registered_name_idx ON tools (registered_name);
  `,
  `
  CREATE TABLE bindings (
    project_id TEXT NOT NULL,
    registered_name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY (project_id, registered_name)
  );
  `,
  `
  CREATE TABLE oauth_tokens (
    server_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT
  );
  `,
  `
  CREATE TABLE oauth_pending (
    server_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Appended, never edited: the array index is the migration id. The
  // authorization server, the client this plugin registered with it and the
  // redirect uri that registration was bound to all have to survive a restart
  // between the authorize redirect and the callback, or the callback arrives
  // with nowhere to exchange its code.
  `
  CREATE TABLE oauth_clients (
    server_id TEXT PRIMARY KEY,
    resource_url TEXT NOT NULL,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    registration_endpoint TEXT,
    client_id TEXT NOT NULL,
    client_secret TEXT,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Refresh is scheduled from LOCAL receipt time, so the lifetime the server
  // quoted and the moment this plugin received it are both stored. An
  // absolute expiry alone cannot be trusted: the clock that produced it is
  // not the clock that reads it.
  `
  ALTER TABLE oauth_tokens ADD COLUMN obtained_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE oauth_tokens ADD COLUMN expires_in INTEGER;
  `,
  // `read_only` is overwritten on every sync but `ask` was not, so the two
  // drifted apart in exactly the direction that matters: a server that
  // advertised a write as read-only, got `ask = 0`, and later corrected the
  // annotation left the consent gate disarmed forever. This column is what
  // tells a user's explicit choice apart from a readOnly-derived default, so
  // the default can be re-derived when the annotation moves under it.
  // Existing rows default to 0: they were derived, not chosen.
  `
  ALTER TABLE tools ADD COLUMN ask_overridden INTEGER NOT NULL DEFAULT 0;
  `,
  // A tool nobody ticked on is invisible in every project, so every project
  // pays the setup cost again. This column makes a tool available everywhere
  // unless a project's binding row overrides it off.
  // Existing rows default to 0: no user has been offered this choice yet, and
  // switching a catalog on behalf of the user is the one outcome a default
  // must never produce.
  `
  ALTER TABLE tools ADD COLUMN default_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  // The manual OAuth client moves from plugin settings to the server it
  // belongs to. Settings keys are static, and the set of servers needing a
  // client the user created themselves is not: Slack, Google, a self-hosted
  // server, a second account for a service already configured. One
  // `googleClientId` could only ever serve the first of those.
  // `oauth_scopes` holds the raw string the user typed, normalised only when
  // the authorize URL is built, so the panel gives back what was entered.
  `
  ALTER TABLE servers ADD COLUMN oauth_client_id TEXT;
  ALTER TABLE servers ADD COLUMN oauth_client_secret TEXT;
  ALTER TABLE servers ADD COLUMN oauth_scopes TEXT;
  `,
  // Until defaults existed, `listBindings` read only `enabled = 1`, so a row
  // with 0 was indistinguishable from no row at all: the panel wrote one
  // whenever a box was unticked, and nothing ever read it. A binding row is
  // now an override, which would silently turn every one of those dead rows
  // into a standing refusal of a default the user has not yet chosen -- an
  // intent nobody expressed, on exactly the tools they had shown interest in.
  // Safe to run once here and never again: after this migration a 0 row is a
  // deliberate "off for this project" and must be kept.
  `
  DELETE FROM bindings WHERE enabled = 0;
  `,
  // Static-token servers are the common case among remote MCP servers that do
  // not speak OAuth, and until now there was nowhere to put the token: the
  // only header this plugin ever sent was the OAuth bearer it minted itself.
  // A JSON object, like `env`, and empty for every server that predates it.
  `
  ALTER TABLE servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
  `,
  // Why a refresh stopped working, kept where the panel, the CLI and a tool
  // call can all read it. Until now the only record was a log line: a grant
  // Cloudflare Access ended at its 24-hour "grant session duration" left the
  // server answering 401 every seventeen minutes with nobody told, because a
  // status of `needs-reconnect` is only visible to a panel that happens to be
  // open. On `servers` rather than `oauth_tokens` so it survives the token row
  // being deleted, and so a header-authenticated server that starts refusing
  // has somewhere to say so too.
  `
  ALTER TABLE servers ADD COLUMN auth_error TEXT;
  ALTER TABLE servers ADD COLUMN auth_error_at INTEGER;
  `,
  // What the user said this connection IS, as opposed to how it is spoken to.
  // `transport` stays the wire fact; `kind` is what the panel asks for and
  // labels a row with, so "Executor gateway" can be its own choice without a
  // gateway becoming a separate code path. Backfilled from the transport,
  // which is exactly what every existing row meant.
  `
  ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT '';
  UPDATE servers SET kind = CASE transport WHEN 'stdio' THEN 'local' ELSE 'remote' END;
  `,
];
