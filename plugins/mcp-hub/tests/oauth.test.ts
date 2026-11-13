import { describe, expect, it } from "vitest";
import { createOAuthProvider, forgetTokens, hasTokens, storedRedirectUri } from "../src/mcp/oauth.js";
import { createSecretStore } from "../src/storage/secrets.js";

const redirectUri = "https://bb.example/plugins/mcp-hub/mcp-hub/oauth/callback";

describe("oauth provider", () => {
  it("carries the redirect URI and client metadata the SDK needs", () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({
      serverId: "linear",
      redirectUri,
      secrets,
      scopes: "read write",
    });
    expect(provider.redirectUrl).toBe(redirectUri);
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      scope: "read write",
    });
  });

  it("persists a state before the browser leaves, so a callback can be routed", () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    expect(secrets.findByOAuthState(provider.flowState)).toBe("linear");
  });

  it("keeps the state of an unfinished flow when a refresh builds a provider", () => {
    const secrets = createSecretStore(null);
    const first = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    const second = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    expect(second.flowState).toBe(first.flowState);
  });

  it("captures the URL the browser should visit", async () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    expect(provider.authorizationUrl).toBeNull();
    await provider.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
    expect(provider.authorizationUrl).toBe("https://auth.example/authorize?x=1");
  });

  it("stores and returns a registered client and a grant", async () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    await provider.saveClientInformation!({ client_id: "cid", client_secret: "cs" });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });

    expect(provider.clientInformation()).toEqual({ client_id: "cid", client_secret: "cs" });
    expect(provider.tokens()).toMatchObject({ access_token: "at", refresh_token: "rt" });
    expect(hasTokens(secrets, "linear")).toBe(true);
    expect(storedRedirectUri(secrets, "linear")).toBe(redirectUri);
  });

  it("clears the verifier and the state once a grant arrives", async () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    await provider.saveCodeVerifier("verifier");
    expect(provider.codeVerifier()).toBe("verifier");

    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    expect(secrets.get("linear").oauth?.codeVerifier).toBeUndefined();
    expect(secrets.findByOAuthState(provider.flowState)).toBeNull();
    expect(() => provider.codeVerifier()).toThrow(/expired/);
  });

  it("uses a hand-registered client instead of dynamic registration", () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({
      serverId: "slack",
      redirectUri,
      secrets,
      staticClient: { clientId: "manual", clientSecret: "manual-secret" },
    });
    expect(provider.clientInformation()).toEqual({
      client_id: "manual",
      client_secret: "manual-secret",
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("forgets a grant without losing the client", async () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    await provider.saveClientInformation!({ client_id: "cid" });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    forgetTokens(secrets, "linear");
    expect(hasTokens(secrets, "linear")).toBe(false);
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
  });

  it("invalidates only what was asked for", async () => {
    const secrets = createSecretStore(null);
    const provider = createOAuthProvider({ serverId: "linear", redirectUri, secrets });
    await provider.saveClientInformation!({ client_id: "cid" });
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.invalidateCredentials!("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
    await provider.invalidateCredentials!("all");
    expect(provider.clientInformation()).toBeUndefined();
  });
});
