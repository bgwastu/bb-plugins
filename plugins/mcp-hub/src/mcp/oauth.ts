// OAuth for remote servers, built on the MCP SDK's own client instead of a
// hand-rolled flow. The SDK owns discovery (RFC 9728 and the authorization
// server metadata), dynamic client registration, PKCE, refresh and the
// resource indicator; this file only supplies the four things it cannot know:
// where the browser redirects to, where the credentials are kept, which
// client an operator registered by hand, and what scope to ask for.
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ServerSecrets, SecretStore } from "../storage/secrets.js";

export interface OAuthProviderOptions {
  serverId: string;
  /** Built from the origin the browser is on, at connect time. */
  redirectUri: string;
  secrets: SecretStore;
  /** A client the user registered by hand, instead of dynamic registration. */
  staticClient?: { clientId: string; clientSecret?: string | null };
  scopes?: string | null;
}

export interface HubOAuthProvider extends OAuthClientProvider {
  /** Set by `redirectToAuthorization`; the URL to send the browser to. */
  readonly authorizationUrl: string | null;
  /** The `state` this flow is carrying, for routing the callback back. */
  readonly flowState: string;
}

function newState(): string {
  return randomBytes(24).toString("base64url");
}

function oauthOf(secrets: ServerSecrets) {
  return secrets.oauth ?? {};
}

/**
 * One provider per flow. Nothing is cached between calls: a provider is built
 * where a connection or a callback needs it, so a refresh that happens hours
 * later reads whatever the secrets file holds then.
 */
export function createOAuthProvider(options: OAuthProviderOptions): HubOAuthProvider {
  const { serverId, redirectUri, secrets } = options;
  let authorizationUrl: string | null = null;

  const read = (): ServerSecrets => secrets.get(serverId);
  const write = (change: (current: ServerSecrets) => ServerSecrets): void => {
    secrets.update(serverId, change);
  };

  // The state is persisted before the browser leaves, because the callback
  // arrives in a different request with nothing else to identify the flow by.
  // An unfinished flow keeps its state: building a provider for a background
  // token refresh must not invalidate a sign-in the user is halfway through.
  const stored = oauthOf(read()).state;
  const flowState = stored ?? newState();
  if (!stored) write((current) => ({ ...current, oauth: { ...oauthOf(current), state: flowState } }));

  return {
    get redirectUrl() {
      return redirectUri;
    },
    get clientMetadata(): OAuthClientMetadata {
      const metadata: OAuthClientMetadata = {
        client_name: "BB MCP Hub",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: options.staticClient?.clientSecret ? "client_secret_post" : "none",
      };
      if (options.scopes) metadata.scope = options.scopes;
      return metadata;
    },
    state() {
      return flowState;
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      if (options.staticClient) {
        return {
          client_id: options.staticClient.clientId,
          ...(options.staticClient.clientSecret ? { client_secret: options.staticClient.clientSecret } : {}),
        };
      }
      const saved = oauthOf(read()).client;
      return saved as OAuthClientInformationMixed | undefined;
    },
    saveClientInformation(information) {
      write((current) => ({
        ...current,
        oauth: { ...oauthOf(current), client: information as Record<string, unknown> },
      }));
    },
    tokens(): OAuthTokens | undefined {
      const tokens = oauthOf(read()).tokens;
      return tokens as OAuthTokens | undefined;
    },
    saveTokens(tokens) {
      write((current) => ({
        ...current,
        oauth: {
          ...oauthOf(current),
          tokens: tokens as unknown as Record<string, unknown>,
          // A completed flow has nothing left to route and nothing left to
          // verify; keeping them would let a replay of the callback find a
          // verifier for a code already spent.
          state: undefined,
          codeVerifier: undefined,
          redirectUri,
        },
      }));
    },
    redirectToAuthorization(url) {
      authorizationUrl = url.toString();
    },
    saveCodeVerifier(verifier) {
      write((current) => ({
        ...current,
        oauth: { ...oauthOf(current), codeVerifier: verifier, state: flowState, redirectUri },
      }));
    },
    codeVerifier() {
      const verifier = oauthOf(read()).codeVerifier;
      if (!verifier) throw new Error("This sign-in has expired. Press Connect again.");
      return verifier;
    },
    saveDiscoveryState(state: OAuthDiscoveryState) {
      write((current) => ({
        ...current,
        oauth: { ...oauthOf(current), discovery: state as unknown as Record<string, unknown> },
      }));
    },
    discoveryState(): OAuthDiscoveryState | undefined {
      return oauthOf(read()).discovery as OAuthDiscoveryState | undefined;
    },
    invalidateCredentials(scope) {
      write((current) => {
        const oauth = { ...oauthOf(current) };
        if (scope === "all" || scope === "tokens") oauth.tokens = undefined;
        if (scope === "all" || scope === "client") oauth.client = undefined;
        if (scope === "all" || scope === "verifier") {
          oauth.codeVerifier = undefined;
          oauth.state = undefined;
        }
        if (scope === "all" || scope === "discovery") oauth.discovery = undefined;
        return { ...current, oauth };
      });
    },
    get authorizationUrl() {
      return authorizationUrl;
    },
    get flowState() {
      return flowState;
    },
  };
}

/** The redirect URI a pending flow was started with, if one is stored. */
export function storedRedirectUri(secrets: SecretStore, serverId: string): string | null {
  return secrets.get(serverId).oauth?.redirectUri ?? null;
}

/** Whether this server holds tokens at all. */
export function hasTokens(secrets: SecretStore, serverId: string): boolean {
  const tokens = secrets.get(serverId).oauth?.tokens as { access_token?: unknown } | undefined;
  return typeof tokens?.access_token === "string" && tokens.access_token.length > 0;
}

/** Forgets a grant without touching a hand-registered client id. */
export function forgetTokens(secrets: SecretStore, serverId: string): void {
  secrets.update(serverId, (current) => ({
    ...current,
    oauth: { ...oauthOf(current), tokens: undefined, state: undefined, codeVerifier: undefined },
  }));
}
