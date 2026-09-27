---
name: usagi
description: Check real-time AI quota, usage limits, and reset timers across provider accounts (Codex, Antigravity, Cursor, Tavily, Exa, Composio, Command Code).
---

# Usagi AI Usage Tracking

Usagi tracks live quota, spend, and windowed rate limits across AI accounts and providers.

## CLI Usage

Run `bb usagi` from any shell to inspect the live board:

```bash
bb usagi              # Formatted overview of all accounts and quota meters
bb usagi list         # Quick summary list
bb usagi list --json  # Full JSON payload
bb usagi refresh      # Force an immediate sync from the Usagi endpoint
```

## Agent Tool

When available, agents can call the `get_ai_usage` native tool:
- Parameter `forceRefresh` (boolean, optional): bypass cache to get up-to-the-minute rate limits.

Use this before delegating large batch queries, running heavy agent loops, or selecting models to ensure adequate quotas remain.
