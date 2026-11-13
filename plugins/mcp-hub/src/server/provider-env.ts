// What this plugin can turn OFF in a provider, so that what it turns on means
// something.
//
// A provider loads MCP servers of its own accord - Claude Code pulls the
// connectors attached to the signed-in claude.ai account - and those arrive
// alongside this plugin's tools, outside any selection this plugin keeps. The
// cost is not theoretical: twelve claude.ai connectors have been measured at
// roughly 188k prompt tokens a session.
//
// This used to be unconditional. It is a setting now, off by default, because
// the plugin does not own the user's provider configuration: someone may want
// both, and the panel cannot make that cheaper either way.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const DISABLE_CONNECTORS_SETTING = "disableClaudeConnectors";

export function registerProviderEnv(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    [DISABLE_CONNECTORS_SETTING]: {
      type: "boolean",
      label: "Disable claude.ai connectors",
      description:
        "Claude Code loads the connectors attached to your claude.ai account on its own, outside this plugin's tools. "
        + "Turn this on to stop that and make the MCP page the only source of MCP tools in Claude Code threads. "
        + "It does not touch servers you wrote into ~/.claude.json yourself, and Codex has no equivalent: set "
        + "[features] apps = false in ~/.codex/config.toml instead.",
      default: false,
    },
  });

  async function suppressing(): Promise<boolean> {
    try {
      return (await settings.get())[DISABLE_CONNECTORS_SETTING] === true;
    } catch {
      // A settings read that fails after dispose is not a reason to change a
      // provider's environment.
      return false;
    }
  }

  bb.providers.experimental_contributeEnv("claude-code", async () => {
    if (!(await suppressing())) return [];
    return [
      {
        name: "ENABLE_CLAUDEAI_MCP_SERVERS",
        value: "0",
        reason: "MCP tools come from the MCP Hub plugin, so claude.ai connectors are off",
      },
    ];
  });

  // Without this the thread's environment view shows an override with no
  // account of itself. The label is what a user scanning that list reads.
  bb.providers.experimental_contributeEnvHealth("claude-code", async () =>
    (await suppressing())
      ? {
          label: "MCP via plugin",
          statusMessage: "claude.ai connectors are not loaded; MCP tools come from the MCP Hub plugin.",
        }
      : null,
  );
}
