/**
 * The narrow slice of `fetch` this plugin's OAuth code uses.
 *
 * Deliberately not `typeof fetch`: under `strictFunctionTypes` a test double
 * written as `async (url: string) => Response` is not assignable to the DOM's
 * `fetch`, and every OAuth test has to inject one or it would reach the real
 * Notion. Narrowing the parameter to what this module actually passes makes
 * the double assignable and the real `fetch` assignable too.
 */
export type FetchLike = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

/** Where an authorization server's three endpoints live. */
export interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** `null` when the server does not do Dynamic Client Registration (Gmail). */
  registrationEndpoint: string | null;
  /**
   * The scopes the server says it understands, empty when it advertises none.
   *
   * Read for exactly one decision: whether to ask for `offline_access`. Many
   * OIDC authorization servers issue no refresh token unless a client names
   * that scope, and a connection that dies at the first access-token expiry is
   * not a connection. But sending it to a server that never advertised it is
   * how a working authorization request starts being refused, so it goes out
   * only when the server has said it exists (MCP SEP-2207).
   */
  scopesSupported: string[];
}

interface AuthServerMetadataDocument {
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  scopes_supported?: unknown;
}

interface ProtectedResourceDocument {
  authorization_servers?: unknown;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    // A discovery document that is missing, unparseable or unreachable is not
    // an error: the conventional endpoints below are the documented fallback.
    return null;
  }
}

/**
 * The two places a well-known document can live for a resource with a path.
 *
 * RFC 8414 and RFC 9728 insert the well-known segment BEFORE the resource's
 * own path (`/.well-known/x/mcp`), while plenty of deployed servers only
 * serve it at the root (`/.well-known/x`). Trying both costs one extra 404
 * against a server that is already being contacted.
 */
function wellKnownCandidates(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/+$/, "");
  const candidates = [`${base.origin}/.well-known/${suffix}`];
  if (path !== "") candidates.unshift(`${base.origin}/.well-known/${suffix}${path}`);
  return candidates;
}

/** `new URL`, for input that came off the network and may be anything. */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether an endpoint is safe to send a secret to.
 *
 * RFC 8414 requires https for an authorization server, and the requests this
 * module makes carry the authorization code, the PKCE verifier and, for a
 * manually created client, the client secret. A discovery document is
 * attacker-influenced input - it is fetched from the very server being
 * authorized against - so an `http://` endpoint in one is not a server making
 * a mistake to work around, it is a downgrade to refuse.
 *
 * Loopback is the one exception, and only because a developer running an MCP
 * server on their own machine has no interceptable hop to protect.
 */
function isSecureEndpoint(value: string): boolean {
  const url = safeUrl(value);
  if (!url) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:"
    && (url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]"
      || url.hostname === "::1");
}

function readMetadata(
  document: Record<string, unknown>,
): AuthServerMetadata | null {
  const doc = document as AuthServerMetadataDocument;
  if (typeof doc.authorization_endpoint !== "string") return null;
  if (typeof doc.token_endpoint !== "string") return null;
  // An unusable document rather than a thrown error: the caller goes on to
  // the next candidate and then to the conventional https endpoints, so a
  // server that publishes a downgraded document loses its document, not its
  // chance of working.
  if (!isSecureEndpoint(doc.authorization_endpoint)) return null;
  if (!isSecureEndpoint(doc.token_endpoint)) return null;
  return {
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    // Dropped rather than kept when insecure: without it the flow asks for a
    // manually created client id, which is a worse experience but not a
    // client secret sent in cleartext.
    registrationEndpoint: typeof doc.registration_endpoint === "string"
      && isSecureEndpoint(doc.registration_endpoint)
      ? doc.registration_endpoint
      : null,
    scopesSupported: Array.isArray(doc.scopes_supported)
      ? doc.scopes_supported.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

/**
 * Finds an MCP server's authorization server, with `fetch` injected.
 *
 * Walks RFC 9728 (`oauth-protected-resource`, which names the authorization
 * server) then RFC 8414 (`oauth-authorization-server`, which names its
 * endpoints), and falls back to the conventional `/authorize`, `/token` and
 * `/register` paths on the resource's own origin. The fallback matters: a
 * server that publishes nothing is common enough that failing discovery
 * outright would block servers that would otherwise work.
 */
export async function discoverWith(
  fetchImpl: FetchLike,
  resourceUrl: string,
): Promise<AuthServerMetadata> {
  const resource = new URL(resourceUrl);

  const issuers: URL[] = [];
  for (const candidate of wellKnownCandidates(resource, "oauth-protected-resource")) {
    const document = await fetchJson(fetchImpl, candidate);
    const servers = (document as ProtectedResourceDocument | null)?.authorization_servers;
    if (Array.isArray(servers)) {
      for (const entry of servers) {
        // Parsed here, once, so nothing downstream calls `new URL` on a
        // string that came off the network. An entry this module cannot
        // parse is a bad document, and this function's whole contract is
        // that a bad document falls back rather than throws.
        const parsed = typeof entry === "string" ? safeUrl(entry) : null;
        if (parsed) issuers.push(parsed);
      }
      if (issuers.length > 0) break;
    }
  }
  // No usable protected-resource document: the resource is its own issuer,
  // which is what a server that publishes only
  // `/.well-known/oauth-authorization-server` looks like.
  if (issuers.length === 0) issuers.push(new URL(resource.origin));

  for (const issuer of issuers) {
    const candidates = [
      ...wellKnownCandidates(issuer, "oauth-authorization-server"),
      ...wellKnownCandidates(issuer, "openid-configuration"),
    ];
    for (const candidate of candidates) {
      const document = await fetchJson(fetchImpl, candidate);
      const metadata = document && readMetadata(document);
      if (metadata) return metadata;
    }
  }

  // Conventional endpoints, on the first issuer it would be safe to send a
  // secret to. There is deliberately no insecure last resort: inventing
  // `http://` endpoints for a server that published none would put the
  // authorization code and the PKCE verifier on the wire in cleartext.
  const fallback = issuers.find((issuer) => isSecureEndpoint(issuer.href));
  if (!fallback) {
    throw new Error(
      `No https authorization server could be found for "${resourceUrl}"; `
      + "refusing to send credentials over an insecure connection.",
    );
  }
  return {
    authorizationEndpoint: `${fallback.origin}/authorize`,
    tokenEndpoint: `${fallback.origin}/token`,
    registrationEndpoint: `${fallback.origin}/register`,
    // A server that published no document advertises no scopes, so nothing is
    // assumed about what it would accept.
    scopesSupported: [],
  };
}

/** {@link discoverWith} over the real network. */
export function discover(resourceUrl: string): Promise<AuthServerMetadata> {
  return discoverWith(fetch, resourceUrl);
}

/**
 * Dynamic Client Registration (RFC 7591), with `fetch` injected.
 *
 * Notion and Slack support this, which is what lets the plugin ship with no
 * per-user setup for them. The registration is anonymous - no initial access
 * token - because that is what those servers accept.
 */
export async function registerClientWith(
  fetchImpl: FetchLike,
  metadata: AuthServerMetadata,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!metadata.registrationEndpoint) {
    throw new Error(
      "This MCP server does not offer dynamic client registration, so it needs a "
      + "client id and secret you create yourself.",
    );
  }
  const response = await fetchImpl(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "BB",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Dynamic client registration failed with HTTP ${response.status}: `
      + `${(await response.text()).slice(0, 200)}`,
    );
  }
  // A 200 is not a promise of JSON. This endpoint is often the conventional
  // `/register` fallback synthesised from the resource's origin, and a host
  // that serves a single-page app answers every unrouted path with its index
  // page - so parsing the body raw puts a JSON syntax error in front of a user
  // who never said this server spoke OAuth.
  const raw = await response.text();
  let body: { client_id?: unknown; client_secret?: unknown };
  try {
    body = JSON.parse(raw) as { client_id?: unknown; client_secret?: unknown };
  } catch {
    throw new Error(
      `${metadata.registrationEndpoint} answered dynamic client registration with `
      + `${response.headers.get("content-type") ?? "an unknown content type"} rather `
      + "than JSON, so this server does not appear to support OAuth. If it "
      + "authenticates with a token, set that under Headers instead.",
    );
  }
  if (typeof body.client_id !== "string") {
    throw new Error("The authorization server registered no client id");
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === "string" ? body.client_secret : null,
  };
}

/** {@link registerClientWith} over the real network. */
export function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  return registerClientWith(fetch, metadata, redirectUri);
}
