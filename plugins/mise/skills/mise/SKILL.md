---
name: mise
description: Manage mise toolchains, runtimes (Node, Python, Bun, Go, Rust), tasks, and harness updates with bb mise CLI commands and native mise_* agent tools.
---

# Mise Manager

Use `bb mise` commands and `mise_*` agent tools to inspect active tools, install runtimes, execute defined tasks, view environment variables, and manage fleet updates adhering to mise.

## When to use

- Checking active runtime versions in project or global fleet (`node`, `python`, `bun`, `go`, etc.).
- Installing or pinning language runtimes for a project without polluting system packages.
- Running predefined mise tasks (`setup`, `sync`, `scheduler:sync`, `build`, `test`).
- Inspecting environment variables or PATH precedence configured by mise.
- Updating core AI coding harness packages (`npm:bb-app`, `pi`, `opencode`) and other outdated tools.

## Commands

```bash
# Status and health overview
bb mise status

# List active and installed tools
bb mise ls
bb mise ls --json

# List outdated packages with target versions
bb mise outdated
bb mise outdated --json

# Upgrade tools via mise (handles bb-app, pi, opencode)
bb mise update
bb mise update npm:bb-app pi opencode

# Install a tool version
bb mise install node@22
bb mise install bun@latest

# Pin a tool version (project-local by default, or global)
bb mise use node@22
bb mise use -g python@3.12

# List and run defined tasks
bb mise tasks
bb mise run setup
bb mise run sync

# Environment variables
bb mise env
bb mise env --json

# Diagnostics
bb mise doctor
```

## Agent Tools

- `mise_list_tools({ cwd? })`: Query active and installed tools with versions and config sources.
- `mise_install_tool({ tool, version?, cwd? })`: Install a tool version safely.
- `mise_use_tool({ tool, version, global?, cwd? })`: Pin a tool version for project or global.
- `mise_run_task({ task, args?, cwd? })`: Run a defined mise task and capture its output.
- `mise_get_env({ cwd? })`: Get the resolved environment variables dictionary.
