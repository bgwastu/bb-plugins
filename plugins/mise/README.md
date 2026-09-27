# bb-plugin-mise

A BB plugin to manage `mise` toolchains, project language runtimes, tasks, and fleet AI harness updates (`npm:bb-app`, `pi`, `opencode`).

## Features

- **Fleet & Project Scope**: Switch between a shared fleet configuration, global user config (`~/.config/mise/config.toml`), and project config (`.mise.toml`).
- **Mise-Aware Update Center**: Highlights your AI harness (`bb-app`, `pi`, `opencode`) and allows 1-click upgrades through mise, bypassing raw npm global or npx traps.
- **Native BB Terminal Execution**: Runs `mise run <task>` directly inside interactive BB terminal tabs.
- **Agent Capabilities**: Native agent tools to inspect runtimes, install dependencies, and execute project tasks reliably.
- **CLI Commands**: Full suite of `bb mise ...` subcommands.

## Installation & Build

```bash
cd plugins/mise
bb plugin build
bb plugin install --yes .
```
