import type Database from "better-sqlite3";

/**
 * One authorization attempt, parked between the browser redirect and the
 * callback.
 *
 * In SQLite rather than in a Map because the two halves of the flow are
 * minutes and a browser apart: a BB restart while the user is on Notion's
 * consent screen would otherwise strand the callback with a state nobody
 * remembers, and the user would see a failure with nothing to retry.
 */
export interface PendingAuth {
  serverId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

/**
 * What this plugin is registered as with one server's authorization server.
 *
 * `redirectUri` is part of the record because it is part of what the client
 * was registered FOR: an authorization server rejects a token exchange whose
 * redirect uri differs from the one in the authorize request, so a client
 * registered against a different loopback port is not reusable.
 */
export interface OAuthClient {
  serverId: string;
  resourceUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  createdAt: number;
}

/**
 * A stored grant.
 *
 * `obtainedAt` and `expiresIn` are stored separately, and `expiresAt` is only
 * a convenience derived from them, because refresh is scheduled from the
 * moment this process received the token. An absolute expiry computed by the
 * authorization server's clock is not comparable with this machine's.
 */
export interface OAuthTokens {
  serverId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Seconds the server quoted, or `null` when it quoted none. */
  expiresIn: number | null;
  /** Local ms timestamp at which the access token was received. */
  obtainedAt: number;
  scope: string | null;
}

export interface OAuthStore {
  putPending(pending: PendingAuth): void;
  /**
   * Reads and DELETES the pending row for `state` in one transaction.
   *
   * There is no plain `getPending`: the callback route is unauthenticated, so
   * the nonce being single-use is a security property, not a cleanup detail,
   * and an interface that can read without consuming is an interface that can
   * be misused into a replayable callback.
   */
  takePending(state: string): PendingAuth | undefined;
  clearPending(serverId: string): void;
  putClient(client: OAuthClient): void;
  getClient(serverId: string): OAuthClient | undefined;
  putTokens(tokens: OAuthTokens): void;
  getTokens(serverId: string): OAuthTokens | undefined;
  /** Drops a refresh token the server has definitively rejected. */
  clearRefreshToken(serverId: string): void;
  deleteTokens(serverId: string): void;
  /**
   * Forgets the client this plugin registered for `serverId`.
   *
   * Part of removing a server rather than a maintenance chore: the row carries
   * the resource URL a stored token was issued for, and leaving it behind
   * would let a new server reusing the same slug inherit that binding.
   */
  deleteClient(serverId: string): void;
}

interface PendingRow {
  server_id: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: number;
}

interface ClientRow {
  server_id: string;
  resource_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  client_id: string;
  client_secret: string | null;
  redirect_uri: string;
  created_at: number;
}

interface TokenRow {
  server_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
  obtained_at: number;
  expires_in: number | null;
}

export function createOAuthStore(db: Database.Database): OAuthStore {
  const insertPending = db.prepare(
    `INSERT INTO oauth_pending
       (server_id, state, code_verifier, redirect_uri, created_at)
     VALUES (@server_id, @state, @code_verifier, @redirect_uri, @created_at)
     ON CONFLICT(server_id) DO UPDATE SET
       state = excluded.state,
       code_verifier = excluded.code_verifier,
       redirect_uri = excluded.redirect_uri,
       created_at = excluded.created_at`,
  );
  const selectPending = db.prepare("SELECT * FROM oauth_pending WHERE state = ?");
  const deletePendingByState = db.prepare("DELETE FROM oauth_pending WHERE state = ?");
  const deletePendingByServer = db.prepare("DELETE FROM oauth_pending WHERE server_id = ?");

  // One transaction, so two callbacks racing the same state cannot both read
  // it before either deletes it.
  const takePendingTx = db.transaction((state: string): PendingRow | undefined => {
    const row = selectPending.get(state) as PendingRow | undefined;
    if (row) deletePendingByState.run(state);
    return row;
  });

  const upsertClient = db.prepare(
    `INSERT INTO oauth_clients
       (server_id, resource_url, authorization_endpoint, token_endpoint,
        registration_endpoint, client_id, client_secret, redirect_uri, created_at)
     VALUES (@server_id, @resource_url, @authorization_endpoint, @token_endpoint,
             @registration_endpoint, @client_id, @client_secret, @redirect_uri,
             @created_at)
     ON CONFLICT(server_id) DO UPDATE SET
       resource_url = excluded.resource_url,
       authorization_endpoint = excluded.authorization_endpoint,
       token_endpoint = excluded.token_endpoint,
       registration_endpoint = excluded.registration_endpoint,
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       redirect_uri = excluded.redirect_uri,
       created_at = excluded.created_at`,
  );
  const selectClient = db.prepare("SELECT * FROM oauth_clients WHERE server_id = ?");

  const upsertTokens = db.prepare(
    `INSERT INTO oauth_tokens
       (server_id, access_token, refresh_token, expires_at, scope, obtained_at,
        expires_in)
     VALUES (@server_id, @access_token, @refresh_token, @expires_at, @scope,
             @obtained_at, @expires_in)
     ON CONFLICT(server_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       obtained_at = excluded.obtained_at,
       expires_in = excluded.expires_in`,
  );
  const selectTokens = db.prepare("SELECT * FROM oauth_tokens WHERE server_id = ?");
  const clearRefresh = db.prepare(
    "UPDATE oauth_tokens SET refresh_token = NULL WHERE server_id = ?",
  );
  const deleteTokens = db.prepare("DELETE FROM oauth_tokens WHERE server_id = ?");
  const deleteClient = db.prepare("DELETE FROM oauth_clients WHERE server_id = ?");

  return {
    putPending(pending) {
      insertPending.run({
        server_id: pending.serverId,
        state: pending.state,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        created_at: pending.createdAt,
      });
    },

    takePending(state) {
      const row = takePendingTx(state);
      if (!row) return undefined;
      return {
        serverId: row.server_id,
        state: row.state,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
        createdAt: row.created_at,
      };
    },

    clearPending(serverId) {
      deletePendingByServer.run(serverId);
    },

    putClient(client) {
      upsertClient.run({
        server_id: client.serverId,
        resource_url: client.resourceUrl,
        authorization_endpoint: client.authorizationEndpoint,
        token_endpoint: client.tokenEndpoint,
        registration_endpoint: client.registrationEndpoint,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        created_at: client.createdAt,
      });
    },

    getClient(serverId) {
      const row = selectClient.get(serverId) as ClientRow | undefined;
      if (!row) return undefined;
      return {
        serverId: row.server_id,
        resourceUrl: row.resource_url,
        authorizationEndpoint: row.authorization_endpoint,
        tokenEndpoint: row.token_endpoint,
        registrationEndpoint: row.registration_endpoint,
        clientId: row.client_id,
        clientSecret: row.client_secret,
        redirectUri: row.redirect_uri,
        createdAt: row.created_at,
      };
    },

    putTokens(tokens) {
      upsertTokens.run({
        server_id: tokens.serverId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        // Derived here rather than trusted from the server, and kept only so
        // a reader of the table can see an expiry at a glance; the refresh
        // decision uses obtained_at and expires_in.
        expires_at: tokens.expiresIn === null
          ? null
          : tokens.obtainedAt + tokens.expiresIn * 1000,
        scope: tokens.scope,
        obtained_at: tokens.obtainedAt,
        expires_in: tokens.expiresIn,
      });
    },

    getTokens(serverId) {
      const row = selectTokens.get(serverId) as TokenRow | undefined;
      if (!row) return undefined;
      return {
        serverId: row.server_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresIn: row.expires_in,
        obtainedAt: row.obtained_at,
        scope: row.scope,
      };
    },

    clearRefreshToken(serverId) {
      clearRefresh.run(serverId);
    },

    deleteTokens(serverId) {
      deleteTokens.run(serverId);
    },

    deleteClient(serverId) {
      deleteClient.run(serverId);
    },
  };
}
