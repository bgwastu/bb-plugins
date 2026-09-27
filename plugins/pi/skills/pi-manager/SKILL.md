---
name: pi-manager
description: Manage pi.dev settings, packages, and MCP servers with bb pi CLI commands and pi_* agent tools.
---

# Pi Manager

Use `bb pi` commands and `pi_*` agent tools to inspect or modify pi.dev configurations safely without corrupting JSON syntax or breaking caches.

## When to use

- Viewing current pi settings, default model, default provider, or thinking level.
- Adding, updating, listing, testing, or removing MCP servers in `mcp.json`.
- Managing installed packages in `settings.json`.

## Commands

```bash
# Check status and resolved file paths
bb pi status

# View or update settings
bb pi config get
bb pi config get defaultModel
bb pi config set defaultModel "gemini-3.8-flash-high"
bb pi config set defaultThinkingLevel "low"

# MCP management
bb pi mcp list
bb pi mcp list --json
bb pi mcp get windmill
bb pi mcp set my-server --url "https://api.example.com/mcp" --type http --lifecycle lazy
bb pi mcp test windmill
bb pi mcp remove my-server

# Package management
bb pi package list
bb pi package add "npm:pi-mcp-adapter"
bb pi package remove "npm:old-package"
```

## Agent Tools

- `pi_config_read({ target: "all" | "settings" | "mcp" })`
- `pi_config_set({ key, value })`
- `pi_mcp_list()`
- `pi_mcp_set({ name, url, type, lifecycle, headers })`
- `pi_mcp_remove({ name })`
- `pi_mcp_test({ name })`
