// bb-plugin-mcp-hub - the BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CONSENT_RENDERER_ID } from "./contract.js";
import { ConnectionsPanel } from "./src/ui/connections-panel.js";
import { ConsentPrompt } from "./src/ui/consent-prompt.js";

export default definePluginApp((app) => {
  // `subPath` is the route remainder, and the panel needs it: an OAuth
  // redirect lands on `<panel>/oauth/callback` rather than on the plugin's
  // public HTTP route, so that it works on an origin sitting behind a login.
  app.slots.navPanel({
    id: "mcp-hub",
    title: "MCP",
    icon: "PlugSocket",
    path: "mcp-hub",
    component: ConnectionsPanel,
  });
  // The id is the whole backend-to-frontend link: `bb.ui.requestInput` names
  // this same string as its `rendererId`, and a mismatch would leave every
  // write tool waiting on a prompt that never renders.
  app.slots.pendingInteraction({
    id: CONSENT_RENDERER_ID,
    component: ConsentPrompt,
  });
});
