import type { AuthServerMetadata, FetchLike } from "./discovery.js";
import { registerClientWith } from "./discovery.js";
import { createPkce } from "./pkce.js";
import type { OAuthClient, OAuthStore } from "../storage/oauth-store.js";

/**
 * How long a parked authorization attempt stays usable.
 *
 * The callback route is `auth: "none"` - a browser redirect from Notion
 * carries neither a BB app origin nor a plugin token - so this window is how
 * long an unguessed nonce stays worth guessing. Ten minutes is long enough for
 * a user to read a consent screen and short enough that a nonce is not sitting
 * in the database overnight.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** Refresh once three quarters of the quoted lifetime has been spent. */
const REFRESH_AT = 0.75;

/**
 * The scope that asks an OIDC authorization server for a refresh token.
 *
 * Sent only when the server advertises it. OAuth 2.1 has no way for a client
 * to ask for a refresh token, OIDC does, and MCP SEP-2207's guidance is
 * exactly this: add it when `scopes_supported` lists it, never otherwise,
 * because a server that does not know the scope may refuse the whole request.
 */
const OFFLINE_ACCESS = "offline_access";

/**
 * A grant ended by Cloudflare Access rather than by anything this plugin did.
 *
 * Worth naming specially because the default is a trap: Cloudflare quotes a
 * 15-minute access token, which refreshes fine, and then ends the underlying
 * grant after 24 hours whatever the client does. The symptom is a server that
 * works all day and is dead every morning, and no amount of reconnecting fixes
 * it - only the setting named here does.
 */
function grantExpiryAdvice(tokenEndpoint: string): string {
  try {
    if (!new URL(tokenEndpoint).hostname.endsWith("cloudflareaccess.com")) return "";
  } catch {
    return "";
  }
  return " Cloudflare Access ends an OAuth grant after the application's "
    + "\"Grant session duration\", which defaults to 24 hours - reconnecting "
    + "buys another day and nothing more. Raise it in Zero Trust > Access > "
    + "Applications > your app > Advanced settings.";
}

/**
 * What the panel can render about one server's authorization.
 *
 * `needs-reconnect` is a state rather than an error on purpose: Notion's
 * refresh tokens expire at an absolute 180 days no matter how recently they
 * were used, so every connected Notion server reaches this eventually. It is a
 * button the user presses, not a failure to report.
 */
export type AuthStatus = "disconnected" | "connected" | "needs-reconnect";

export interface OAuthFlow {
  /**
   * `redirectOrigin` is the origin the user's browser is on, so the callback
   * comes back somewhere they can reach. Omitted only where there is no
   * browser to ask - a test, a CLI - and the loopback form is then used.
   */
  begin(
    serverId: string,
    resourceUrl: string,
    redirectOrigin?: string,
  ): Promise<{ authorizeUrl: string }>;
  complete(state: string, code: string): Promise<{ serverId: string }>;
  /**
   * Refreshes when near expiry. `null` when there is nothing usable.
   *
   * `resourceUrl` is the URL the token is about to be sent to, and it is
   * required rather than optional: tokens are keyed on the server SLUG, and a
   * slug outlives the server that earned it. Remove "Notion", add a new server
   * also called "Notion" pointing anywhere, and without this check the first
   * connect would attach the old bearer to the new host.
   */
  accessToken(serverId: string, resourceUrl: string): Promise<string | null>;
  /**
   * Forces a refresh regardless of the local clock, and reports whether a new
   * access token came back.
   *
   * The pair to a 401: the server is authoritative about a token being dead,
   * and a token can be dead long before the lifetime it was quoted runs out.
   */
  refresh(serverId: string): Promise<boolean>;
  /** Synchronous because the panel asks for it on every render. */
  status(serverId: string): AuthStatus;
  /**
   * The redirect URI the stored client was registered with, `null` when there
   * is no client.
   *
   * The panel compares it with the URI this browser would produce. They differ
   * whenever the user connects from a second origin, which silently
   * re-registers - harmless under dynamic client registration, and a broken
   * connection for a client the user created by hand, where the new URI has to
   * be added to the provider first.
   */
  registeredRedirectUri(serverId: string): string | null;
  /**
   * Destroys everything stored for `serverId`: tokens, the registered client,
   * and any authorization left half-finished.
   *
   * Called when a server is removed. Without it a deleted server's plaintext
   * access and refresh tokens stay in the database with no surface able to
   * remove them, and the next server to take that slug inherits them.
   */
  forget(serverId: string): void;
}

export interface OAuthFlowDeps {
  store: OAuthStore;
  /** Injected so tests run against a fake authorization server. */
  discover(resourceUrl: string): Promise<AuthServerMetadata>;
  fetchImpl: FetchLike;
  /**
   * The callback URL for one browser origin, read per call rather than
   * captured: it is built from `bb.server.loopbackBaseUrl` when no origin is
   * given, and that is bind-gated and throws when read at factory scope.
   */
  redirectUri(origin?: string): string;
  /**
   * A client id and secret the user saved against this server, for one that
   * does not do Dynamic Client Registration (Google, Slack, anything
   * self-hosted). Returning `null` means "use registration".
   */
  staticClient?(
    serverId: string,
    resourceUrl: string,
  ): Promise<{ clientId: string; clientSecret: string | null } | null>;
  /**
   * The scopes to ask for, or `null` to let the server decide.
   *
   * Separate from {@link staticClient} on purpose: Slack registers its own
   * client but still issues a token good for nothing unless the authorize
   * request names the scopes, so needing scopes and needing a manual client
   * are independent.
   */
  scopes?(serverId: string): string | null;
  /**
   * This server's credentials stopped working, and why.
   *
   * Reported rather than logged because a log line reaches nobody: a grant
   * that died overnight left this plugin answering 401 every seventeen minutes
   * for days with the only record in a file. The message is written for the
   * user who has to act on it, not for a developer reading a stack trace.
   */
  onAuthFailure?(serverId: string, message: string): void;
  /** Credentials work again; whatever was recorded no longer applies. */
  onAuthRecovered?(serverId: string): void;
  /** Injected so expiry and TTL tests do not have to sleep. */
  now?(): number;
  log?: { warn(message: string): void; info(message: string): void };
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * Whether a failure means "this token is not accepted".
 *
 * The MCP SDK surfaces an HTTP failure in more than one shape - a
 * `StreamableHTTPError` carrying `code`, a plain `Error` whose message quotes
 * the status - so this checks both rather than depending on the SDK's error
 * class, which is not part of its public contract. The message check is
 * anchored on word boundaries so a body that happens to contain "4010" is not
 * read as an authorization failure.
 */
export function isUnauthorized(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  if (candidate.code === 401 || candidate.status === 401) return true;
  return typeof candidate.message === "string" && /\b401\b/.test(candidate.message);
}

/**
 * What the authorization server actually said, in the words it said it in.
 *
 * A token endpoint answers a dead grant with
 * `{"error":"invalid_grant","error_description":"Grant not found"}`, and that
 * description is the only part worth putting in front of a user - the HTTP
 * status and the JSON around it explain nothing they can act on. Falls back to
 * the whole message when the body is not the shape RFC 6749 asks for.
 */
export function describeRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const body = /\{[\s\S]*\}/.exec(message)?.[0];
  if (body !== undefined) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
      const detail = typeof parsed.error_description === "string"
        ? parsed.error_description
        : typeof parsed.error === "string" ? parsed.error : null;
      if (detail !== null && detail.trim() !== "") return detail.trim().slice(0, 200);
    } catch {
      // Not JSON after all; the message below is the honest answer.
    }
  }
  return message.slice(0, 200);
}

function asForm(fields: Record<string, string | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) body.set(key, value);
  }
  return body.toString();
}

/**
 * Whether a stored grant belongs to the URL it is about to be sent to.
 *
 * The client row records the resource the grant was obtained for, so it is the
 * only thing that can answer this. Compared by ORIGIN: a server whose path
 * moved is the same server, a server whose host moved is not. No client row
 * means no grant this flow issued, so nothing to send.
 */
function isBoundTo(client: OAuthClient | undefined, resourceUrl: string): boolean {
  if (!client) return false;
  if (client.resourceUrl === resourceUrl) return true;
  try {
    return new URL(client.resourceUrl).origin === new URL(resourceUrl).origin;
  } catch {
    return false;
  }
}

export function createOAuthFlow(deps: OAuthFlowDeps): OAuthFlow {
  const now = deps.now ?? (() => Date.now());
  // One in-flight refresh per server. Concurrent 401s from parallel tool calls
  // would otherwise each post to the token endpoint, and a server that rotates
  // refresh tokens invalidates the grant of every loser of that race.
  const refreshing = new Map<string, Promise<boolean>>();

  async function exchange(
    tokenEndpoint: string,
    fields: Record<string, string | null>,
  ): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string | null }> {
    const response = await deps.fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: asForm(fields),
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(
          `The authorization server refused the token request with HTTP `
          + `${response.status}: ${(await response.text()).slice(0, 200)}`,
        ),
        { status: response.status },
      );
    }
    const body = await response.json() as TokenResponse;
    if (typeof body.access_token !== "string") {
      throw new Error("The authorization server returned no access token");
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      scope: typeof body.scope === "string" ? body.scope : null,
    };
  }

  /** True once the quoted lifetime is three quarters spent, measured locally. */
  function isStale(obtainedAt: number, expiresIn: number | null): boolean {
    if (expiresIn === null) return false;
    return now() > obtainedAt + expiresIn * REFRESH_AT * 1000;
  }

  async function runRefresh(serverId: string): Promise<boolean> {
    const tokens = deps.store.getTokens(serverId);
    const client = deps.store.getClient(serverId);
    if (!tokens?.refreshToken || !client) return false;
    try {
      const fresh = await exchange(client.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        resource: client.resourceUrl,
      });
      deps.store.putTokens({
        serverId,
        accessToken: fresh.accessToken,
        // Some servers rotate the refresh token and some omit it, in which
        // case the existing one stays valid.
        refreshToken: fresh.refreshToken ?? tokens.refreshToken,
        expiresIn: fresh.expiresIn,
        obtainedAt: now(),
        scope: fresh.scope ?? tokens.scope,
      });
      deps.onAuthRecovered?.(serverId);
      return true;
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      // A 4xx is the server saying this grant is gone - Notion's refresh
      // tokens die at an absolute 180 days - so drop it and let the panel ask
      // for a reconnect. A 5xx or a network failure is transient: keep the
      // grant so the next call tries again.
      const dead = typeof status === "number" && status >= 400 && status < 500;
      if (dead) {
        deps.store.clearRefreshToken(serverId);
        deps.onAuthFailure?.(
          serverId,
          `The authorization server refused to refresh this connection, so it has to be `
          + `reconnected: ${describeRefusal(error)}.${grantExpiryAdvice(client.tokenEndpoint)}`,
        );
      }
      deps.log?.warn(
        `Could not refresh the OAuth token for MCP server "${serverId}": ${String(error)}`,
      );
      return false;
    }
  }

  function refresh(serverId: string): Promise<boolean> {
    const inFlight = refreshing.get(serverId);
    if (inFlight) return inFlight;
    const pending = runRefresh(serverId).finally(() => {
      if (refreshing.get(serverId) === pending) refreshing.delete(serverId);
    });
    refreshing.set(serverId, pending);
    return pending;
  }

  return {
    async begin(serverId, resourceUrl, redirectOrigin) {
      const redirectUri = deps.redirectUri(redirectOrigin);
      const existing = deps.store.getClient(serverId);
      const supplied = await deps.staticClient?.(serverId, resourceUrl) ?? null;
      // A client is reusable only when it was registered for this exact
      // resource AND this exact redirect uri: an authorization server rejects
      // a code whose redirect uri differs from the registered one, and the
      // loopback port can change between BB runs.
      // The third clause is about a client id the user has since corrected:
      // neither of the first two can see it move, so a typo fixed in the panel
      // would be discarded and the stale client reused for good.
      const reusable = existing
        && existing.resourceUrl === resourceUrl
        && existing.redirectUri === redirectUri
        && (supplied === null || existing.clientId === supplied.clientId);

      let client = existing;
      let metadata: AuthServerMetadata | null = null;
      if (!reusable) {
        metadata = await deps.discover(resourceUrl);
        const credentials = supplied
          ?? (metadata.registrationEndpoint
            ? await registerClientWith(deps.fetchImpl, metadata, redirectUri)
            : null);
        if (!credentials) {
          throw new Error(
            `MCP server "${serverId}" does not support dynamic client registration, `
            + "so it needs a client id and secret you create yourself. Open the "
            + `"OAuth client" section on this server in the MCP panel, which also `
            + "shows the redirect URI to authorize.",
          );
        }
        client = {
          serverId,
          resourceUrl,
          authorizationEndpoint: metadata.authorizationEndpoint,
          tokenEndpoint: metadata.tokenEndpoint,
          registrationEndpoint: metadata.registrationEndpoint,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          redirectUri,
          createdAt: now(),
        };
        deps.store.putClient(client);
      }
      if (!client) throw new Error(`No OAuth client for MCP server "${serverId}"`);

      // Discovered even for a reusable client, because the scope decision
      // below needs `scopesSupported` and the client row does not carry it.
      // One metadata fetch on a button the user pressed is affordable; a
      // client that works being refused because that fetch failed is not, so
      // this never becomes fatal on its own.
      let scopesSupported = metadata?.scopesSupported ?? null;
      if (scopesSupported === null) {
        try {
          scopesSupported = (await deps.discover(resourceUrl)).scopesSupported;
        } catch {
          scopesSupported = [];
        }
      }

      const pkce = createPkce();
      // Persisted BEFORE the URL is handed out: the user may follow it on a
      // machine this process never hears from again, and a callback whose
      // state was never written is indistinguishable from a forged one.
      deps.store.putPending({
        serverId,
        state: pkce.state,
        codeVerifier: pkce.verifier,
        redirectUri,
        createdAt: now(),
      });

      const authorizeUrl = new URL(client.authorizationEndpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", client.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", pkce.state);
      authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      // RFC 8707: names the MCP server this token is for, so an authorization
      // server that serves several cannot be talked into issuing one that
      // works against another.
      authorizeUrl.searchParams.set("resource", resourceUrl);
      const scopes = deps.scopes?.(serverId) ?? null;
      // Whitespace or commas in, single spaces out: the stored value is what
      // the user typed, and a scope list is space delimited on the wire.
      const requested = scopes?.split(/[\s,]+/).filter((part) => part !== "") ?? [];
      // Only when the server said it knows the scope: see OFFLINE_ACCESS.
      if (scopesSupported.includes(OFFLINE_ACCESS) && !requested.includes(OFFLINE_ACCESS)) {
        requested.push(OFFLINE_ACCESS);
      }
      const scope = requested.join(" ");
      if (scope !== "") authorizeUrl.searchParams.set("scope", scope);
      // Google issues no refresh token without these two, and a connection
      // that dies at the first access-token expiry is not a connection. RFC
      // 6749 section 3.1 requires an authorization server to ignore request
      // parameters it does not understand, so Notion and Slack are unharmed.
      authorizeUrl.searchParams.set("access_type", "offline");
      authorizeUrl.searchParams.set("prompt", "consent");
      return { authorizeUrl: authorizeUrl.toString() };
    },

    async complete(state, code) {
      // Consumed whatever happens next: an expired nonce that stayed readable
      // would be a nonce an attacker could keep trying.
      const pending = deps.store.takePending(state);
      if (!pending) {
        throw new Error("This OAuth state is unknown or has already been used");
      }
      if (now() - pending.createdAt > PENDING_TTL_MS) {
        throw new Error("This OAuth state expired; start the connection again");
      }
      const client = deps.store.getClient(pending.serverId);
      if (!client) {
        throw new Error(
          `The OAuth client for MCP server "${pending.serverId}" is gone; `
          + "start the connection again",
        );
      }
      const tokens = await exchange(client.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        resource: client.resourceUrl,
      });
      deps.store.putTokens({
        serverId: pending.serverId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        // Local receipt time. The `exp` an authorization server would report
        // is measured on its clock, not this one.
        obtainedAt: now(),
        scope: tokens.scope,
      });
      deps.onAuthRecovered?.(pending.serverId);
      return { serverId: pending.serverId };
    },

    async accessToken(serverId, resourceUrl) {
      const tokens = deps.store.getTokens(serverId);
      if (!tokens) return null;
      if (!isBoundTo(deps.store.getClient(serverId), resourceUrl)) {
        deps.log?.warn(
          `Not sending the stored OAuth token for MCP server "${serverId}" to `
          + `${resourceUrl}: it was issued for a different host. Reconnect the server.`,
        );
        return null;
      }
      if (!isStale(tokens.obtainedAt, tokens.expiresIn)) return tokens.accessToken;
      if (!tokens.refreshToken) return null;
      await refresh(serverId);
      const refreshed = deps.store.getTokens(serverId);
      if (!refreshed) return null;
      // A refresh that failed transiently leaves the old token in place; it is
      // past three quarters of its life but may well still work, and the 401
      // path is what settles it.
      return isStale(refreshed.obtainedAt, refreshed.expiresIn) && !refreshed.refreshToken
        ? null
        : refreshed.accessToken;
    },

    refresh,

    registeredRedirectUri(serverId) {
      return deps.store.getClient(serverId)?.redirectUri ?? null;
    },

    status(serverId) {
      const tokens = deps.store.getTokens(serverId);
      if (!tokens) return "disconnected";
      if (tokens.refreshToken) return "connected";
      // No refresh token left: either the server never issued one, or one was
      // dropped after the server rejected it. Either way the connection lasts
      // only as long as this access token, and the threshold is the same one
      // `accessToken` hands out on - a status that says "connected" while
      // `accessToken` returns null would be a panel showing a green light over
      // a server that cannot answer.
      return isStale(tokens.obtainedAt, tokens.expiresIn)
        ? "needs-reconnect"
        : "connected";
    },

    forget(serverId) {
      deps.store.deleteTokens(serverId);
      deps.store.deleteClient(serverId);
      // A dance the user walked away from is a live nonce for a server that no
      // longer exists; the callback route is unauthenticated, so leaving it is
      // leaving a door open.
      deps.store.clearPending(serverId);
    },
  };
}
