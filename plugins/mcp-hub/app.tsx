// bb-plugin-mcp-hub - the BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// Two surfaces, and nothing else:
//   - the management page, under Settings -> MCP
//   - the MCP button in the composer footer, with one popup
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { McpComposerAction, McpComposerPopup, MCP_POPUP_ID } from "./src/ui/footer.js";
import { McpPanel } from "./src/ui/panel.js";

export default definePluginApp((app) => {
  // `subPath` matters: an OAuth redirect lands on `<panel>/oauth/callback`
  // rather than on the plugin's public HTTP route, so that it works on an
  // origin sitting behind a sign-in.
  app.slots.navPanel({
    id: "mcp-hub",
    title: "MCP",
    icon: "PlugSocket",
    path: "mcp-hub",
    component: McpPanel,
  });

  app.composer.customize({
    id: "mcp-tools",
    // A queued-message composer edits a message, not a session, so it is not
    // offered there.
    scopes: ["thread", "new-thread"],
    actions: [{ id: "mcp", component: McpComposerAction }],
    experimental_popups: [{ id: MCP_POPUP_ID, label: "MCP tools", component: McpComposerPopup }],
  });
});
