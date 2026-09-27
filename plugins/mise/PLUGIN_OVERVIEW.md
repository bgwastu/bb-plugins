Manage mise toolchains, language runtimes, tasks, and fleet harness updates directly inside BB.

## What you get

- **Sidebar Nav Panel**: Clean, high-density dashboard with 4 tabs:
  - **Tools**: Active runtimes, installed versions, source tags (`fleet`, `global`, `project`), and inline version switcher.
  - **Updates**: Dedicated update center for core AI coding harness packages (`npm:bb-app`, `pi`, `opencode`) and other mise tools, with 1-click upgrades adhering to mise.
  - **Tasks**: List of defined tasks (`setup`, `sync`, `scheduler:sync`, `build`, etc.) with 1-click execution in a native BB terminal.
  - **Config & Env**: Exploded PATH precedence explorer, active environment variables, and live TOML viewer.
- **CLI Commands**: `bb mise status`, `bb mise ls`, `bb mise outdated`, `bb mise update`, `bb mise install`, `bb mise use`, `bb mise tasks`, `bb mise run`, `bb mise env`, `bb mise doctor`.
- **Native Agent Tools**: `mise_list_tools`, `mise_install_tool`, `mise_use_tool`, `mise_run_task`, `mise_get_env`.
- **Terminal Integration**: Spawns real BB terminal sessions via `bb.sdk.terminals.create` for interactive task runs.
