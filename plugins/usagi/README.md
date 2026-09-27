# bb-plugin-usagi 🐰

A BB plugin for **Usagi**, providing real-time AI quota and usage tracking across provider accounts (Codex, Antigravity Gemini & Claude, Cursor, Tavily, Exa, Composio, Command Code).

Connects to the [Usagi service](https://github.com/bgwastu/usagi).

## Features

- 🐰 **Rabbit Branding & Icon**: Compact SVG rabbit mask matching BB's 24×24 native stroke icon standard.
- 📊 **Nav Panel (`/plugins/usagi/usage`)**:
  - Live sync indicator & auto-refreshing relative timestamps
  - Metric summary cards (Total Accounts, Active Providers, Quota Health)
  - Interactive filter chips by provider and instant search
  - Progress meter bars with color-coded alerts (Healthy, Warning >75%, Critical >90%)
  - Reset countdown timers ("Resets in 1d 11h")
  - Expandable model breakdown for Antigravity (Gemini 2.5 Pro, Claude Sonnet 4.6 Thinking, Flash, etc.)
  - Button to open the configured Usagi web dashboard
- 🏷️ **Sidebar Accessory**: Live account counter badge right on the sidebar row.
- 🏠 **Homepage Section**: AI Quota snapshot card on the BB homepage / new thread view.
- 💬 **Thread Right-Panel Action**: Open the "AI Quota" inspector in any active thread to monitor rate limits while prompting.
- 💻 **CLI Command**:
  - `bb usagi` — Formatted overview of all accounts, meters, remaining percentages, and reset countdowns.
  - `bb usagi list [--json]` — Quick summary or full JSON payload.
  - `bb usagi refresh` — Force an immediate re-fetch from the Usagi endpoint.
- 🤖 **Agent Tool & Skill**:
  - `get_ai_usage` agent tool allowing agents to verify rate-limits before or during heavy batch tasks.
  - `skills/usagi/SKILL.md` injected for LLMs.

## Configuration

Settings can be changed in BB Settings → Plugins → Usagi or via CLI:

```bash
# Change endpoint URL
bb plugin config usagi set endpoint "https://usagi.example/api"

# Set password (if USAGI_PASSWORD is enabled)
bb plugin config usagi set password "your-secret-password"

# Set background polling interval (seconds)
bb plugin config usagi set pollIntervalSeconds "60"
```

## Development & Build

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Compile backend & frontend bundles
bb plugin build

# Install in BB
bb plugin install ./plugins/usagi --yes
```
