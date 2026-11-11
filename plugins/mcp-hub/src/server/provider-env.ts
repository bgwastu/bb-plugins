// What this plugin turns OFF in the provider, so that what it turns on means
// something.
//
// A provider loads MCP servers of its own accord - Claude Code pulls the
// connectors attached to the signed-in claude.ai account - and those arrive
// alongside this plugin's tools, under different names, with no relation to
// the per-project selection the panel edits. The cost is not theoretical:
// the design doc measures a bare Claude Code session at 50,329 prompt tokens
// and the same session with twelve claude.ai connectors at 238,052. Nothing
// in the plugin's own selection can reach that.
//
// `experimental_contributeEnv` is the one lever it has. BB folds the entries
// into the thread environment after the shell env and ships them to the
// provider bridge, which spreads them over `process.env` when it builds the
// session - so this is per thread, not per machine, which is what the design
// doc said would need a core change before BB grew this hook.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Registers the provider environment this plugin needs to be the only source
 * of MCP tools.
 *
 * Unconditional, and deliberately so: a switch would describe a state in
 * which the plugin is installed and something else also supplies MCP tools,
 * which is the state this exists to remove.
 *
 * Narrower than the name suggests, in two directions worth stating:
 *
 * - It stops the claude.ai connectors and nothing else. Servers the user
 *   wrote into `~/.claude.json` themselves still load; the only lever over
 *   those is `--strict-mcp-config`, and BB drives Claude Code through the
 *   Agent SDK and never passes it.
 * - There is no Codex counterpart. Codex has no environment variable for
 *   this at all, and contributed env would not reach it anyway - BB maps it
 *   to `shell_environment_policy.set.*`, which is the environment for shell
 *   commands the agent runs, not the codex process. Codex is switched off in
 *   `~/.codex/config.toml` with `[features] apps = false`, by hand, once.
 *   Registering a resolver for `codex` here would be theatre.
 */
export function registerProviderEnv(bb: BbPluginApi): void {
  bb.providers.experimental_contributeEnv("claude-code", () => [
    {
      name: "ENABLE_CLAUDEAI_MCP_SERVERS",
      value: "0",
      reason: "MCP tools come from the MCP plugin, so claude.ai connectors are off",
    },
  ]);
  // Without this the thread's environment view shows an override with no
  // account of itself. The label is what a user scanning that list reads.
  bb.providers.experimental_contributeEnvHealth("claude-code", () => ({
    label: "MCP via plugin",
    statusMessage:
      "claude.ai connectors are not loaded; MCP tools come from the MCP plugin.",
  }));
}
