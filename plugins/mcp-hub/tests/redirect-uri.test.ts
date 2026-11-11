// Where an authorization server is told to send the user back.
//
// The bug behind this file: the callback was always built from
// `bb.server.loopbackBaseUrl`, which is `127.0.0.1` - nowhere at all for a
// browser on another machine. BB answers on several origins at once (a tailnet
// name, a BB Connect tunnel, loopback), and only the browser doing the
// authorizing knows which one it is on.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { oauthRedirectUriFor } from "../contract.js";
import { oauthRedirectUri } from "../src/server/routes.js";

const bb = {
  pluginId: "mcp-hub",
  server: { loopbackBaseUrl: "http://127.0.0.1:38886" },
} as unknown as BbPluginApi;

describe("the oauth redirect uri", () => {
  it("follows the origin the panel is served from", () => {
    expect(oauthRedirectUri(bb, "https://bb.example.ts.net"))
      .toBe("https://bb.example.ts.net/plugins/mcp-hub/mcp-hub/oauth/callback");
  });

  it("lands on the panel rather than on the public http route", () => {
    // What makes it work on an origin behind a login: BB Connect answers
    // `/api/...` with 401 and a sign-in page, which throws the authorization
    // code away. A panel URL is an ordinary app URL.
    expect(oauthRedirectUri(bb, "https://x.example")).not.toContain("/api/");
  });

  it("falls back to loopback for a shell with no http origin", () => {
    for (const origin of [undefined, null, "file://", "not a url"]) {
      expect(oauthRedirectUri(bb, origin)).toBe(
        "http://127.0.0.1:38886/api/v1/plugins/mcp-hub/http/oauth/callback",
      );
    }
  });

  it("is composed the same way on both sides", () => {
    // An authorization server compares the redirect uri byte for byte against
    // the registered one, so the panel and the server cannot each have their
    // own idea of it.
    expect(oauthRedirectUri(bb, "https://x.example/"))
      .toBe(oauthRedirectUriFor("https://x.example"));
  });
});
