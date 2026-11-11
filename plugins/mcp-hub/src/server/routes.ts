import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { oauthRedirectUriFor } from "../../contract.js";
import type { OAuthFlow } from "../oauth/flow.js";
import { infoQuietly, warnQuietly } from "./log.js";

/**
 * The path this plugin's callback is mounted at, under its http namespace.
 *
 * Kept, and kept working, even though the panel is where a redirect lands now:
 * it is the only callback a loopback-only shell can use, and a client already
 * registered against it stays valid until it is next re-registered.
 */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * The absolute callback URL an authorization server redirects back to.
 *
 * `origin` is the host the panel is being served from, and it is the answer
 * whenever there is one: BB is reachable at several origins at once - a
 * tailnet name, a BB Connect tunnel, loopback - and only the browser doing the
 * authorizing knows which of them it is on. `bb.server.loopbackBaseUrl` is
 * `127.0.0.1`, which is nowhere at all for a browser on another machine, so it
 * is the fallback for a shell that has no http(s) origin to offer rather than
 * the default.
 *
 * With an origin the URL points at this plugin's PANEL, not at its public HTTP
 * route - see `OAUTH_CALLBACK_SUBPATH` in the contract for why. Without one
 * there is no app to land in, so the loopback form keeps using the route.
 *
 * `bb.server.loopbackBaseUrl` is bind-gated: reading it before the BB server
 * is listening throws, so this is a function called from a handler rather
 * than a constant computed at load.
 */
export function oauthRedirectUri(bb: BbPluginApi, origin?: string | null): string {
  const usable = origin === undefined || origin === null ? null : safeOrigin(origin);
  if (usable !== null) return oauthRedirectUriFor(usable);
  return `${bb.server.loopbackBaseUrl}/api/v1/plugins/${bb.pluginId}/http${OAUTH_CALLBACK_PATH}`;
}

/** An http(s) origin, or `null` for anything a browser could not have sent. */
function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The page the user's browser lands on after consenting.
 *
 * Deliberately plain and self-contained: it is served to a browser tab that
 * has no BB session, so it can neither load the app's assets nor tell the
 * panel anything directly. Its only job is to say the tab can be closed.
 */
function page(title: string, detail: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:0;display:flex;`
    + `min-height:100vh;align-items:center;justify-content:center;text-align:center">`
    + `<main style="max-width:32rem;padding:2rem">`
    + `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${escapeHtml(title)}</h1>`
    + `<p style="margin:0;color:#666">${escapeHtml(detail)}</p>`
    + `</main></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export interface OAuthRouteDeps {
  flow: OAuthFlow;
  /** A server just connected: re-sync its catalog, tell the panel. */
  onConnected(serverId: string): void;
}

/**
 * Registers the OAuth callback.
 *
 * `auth: "none"` is forced by the shape of the flow, not chosen for
 * convenience: the request is a browser redirect issued by Notion, so it
 * carries no BB app origin ("local" would reject it) and no plugin token
 * ("token" would reject it). What stands in for authentication is the `state`
 * nonce - 32 random bytes, single use, ten minute TTL, checked inside
 * `flow.complete` - so this handler must never do anything with its query
 * parameters before that check has passed.
 */
export function registerOAuthRoutes(bb: BbPluginApi, deps: OAuthRouteDeps): void {
  bb.http.route("GET", OAUTH_CALLBACK_PATH, async (context) => {
    const state = context.req.query("state");
    const code = context.req.query("code");
    const failure = context.req.query("error");

    // The user pressed "cancel" on the consent screen, or the server refused.
    // The pending row is left to expire rather than deleted: `state` here is
    // unverified input, and deleting on it would let anyone cancel a flow
    // they merely guessed at.
    if (failure) {
      return page(
        "Connection cancelled",
        `The service reported "${failure}". You can close this tab and try again in BB.`,
      );
    }
    if (!state || !code) {
      return page(
        "Something is missing",
        "That callback did not carry an authorization code. Close this tab and start the connection again in BB.",
      );
    }

    try {
      const { serverId } = await deps.flow.complete(state, code);
      infoQuietly(bb, `Connected MCP server "${serverId}" over OAuth`);
      deps.onConnected(serverId);
      return page("Connected", "You can close this tab and go back to BB.");
    } catch (error) {
      warnQuietly(bb, `An OAuth callback could not be completed: ${String(error)}`);
      // The message is this plugin's own, never the upstream body: a failed
      // exchange can quote the authorization server, and this page is
      // rendered in a browser with no BB session behind it.
      return page(
        "That did not work",
        "This connection attempt is no longer valid. Close this tab and start it again in BB.",
      );
    }
  }, { auth: "none" });
}
