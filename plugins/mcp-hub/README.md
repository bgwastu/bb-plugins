# bb-plugin-mcp-hub

Connect MCP servers to BB - local stdio processes and remote endpoints, on
OAuth, a bearer token or custom headers - and use their tools in every thread.

Every MCP tool is registered as an ordinary BB agent tool under the name
`<server>_<tool>`. There is no `mcp_call` front door: the model sees
`linear_create_issue`, calls it like any other tool, and the result comes back
in the same shape a native tool returns.

## Two surfaces

**The management page** (Settings -> MCP) is the list: one row per server with
its status dot, its target and a switch. Opening a row gives the tools with
their own switches, a Test dialog that builds a form from the tool's schema,
the recent calls with their errors, and Connect/Edit/Remove.

**The MCP button in the composer footer** shows how many servers are on and
opens the same switches, without leaving the conversation. It is the same
state the page shows, not a copy of it.

## One switch per server

A server is on or off for everyone. There is no per-thread or per-project
selection to reconcile: the switch in the popup and the switch on the page
write the same row, and the next session a thread builds uses whatever is on
then. Within a server, individual tools have the same kind of switch.

New tools arrive **on**. The provider cap is 256 tools per session; past it the
selection is clamped and the page says so.

Turning something **off** is immediate: the tool stays registered but refuses
the call, so a session that already has it cannot use it. Turning something
**on** reaches a session only when that session is built, which is why the
popup offers **Restart thread** after a change - it stops the thread so the
next message starts fresh. Mid-turn, that stop waits for the turn to end.
Anything the agent left running in the session - a background shell, a
sub-agent - stops with it.

## Errors are answers, not dead connections

A JSON-RPC error is the server doing its job. A `-32602 Invalid params` reply
used to drop the client - and, for stdio, kill the child process other threads
were still calling. Now:

- **Arguments are checked against the tool's own schema before the call.** A
  bad argument names the field and the tool is not called at all.
- **Protocol errors travel back as tool errors**, with the server's code and
  message, and the connection stays open.
- **A transport failure drops the client and retries once - reads only.** A
  write that may have landed is reported, never replayed.
- **A 401 is recorded against the server** and shown on the row, in
  `bb mcp-hub list`, and through `bb plugin list` (`needs-configuration`),
  instead of only in a log line.

Results keep everything the server sent: text, images, resources, and
`structuredContent` alongside text - which the old translation dropped.

## Connections

One live client per server, opened lazily by a tool call or by the background
service at load, never on the plugin load path. State is `idle`, `connecting`,
`ready`, `needs-auth` or `failed`, with the last error and last-seen time.

- **Stdio**: a child process per server in its own process group, `PATH`
  resolved the way a login shell would, stderr captured into a bounded tail so
  a failure is legible in the panel. Killing it signals the whole group, so an
  `npx` wrapper cannot leave grandchildren behind.
- **HTTP**: Streamable HTTP first, with one SSE fallback - enough servers still
  speak only the older protocol. Auth headers are attached per request.
- **`tools/list_changed`** triggers a coalesced resync of that server's catalog.
- **A plugin reload is not needed for a selection change.** A changed schema is
  advertised to the next session through the selection's `parameters` override;
  only a changed *description* waits for the next reload, and nothing breaks
  meanwhile.

## Signing in

OAuth is the MCP SDK's own client - discovery, dynamic registration, PKCE,
refresh and the resource indicator - not a hand-rolled flow. This plugin
supplies what the SDK cannot know:

- **The redirect URI**, built from the origin the browser is on when Connect is
  pressed. Not from `bb.server.loopbackBaseUrl`, which is `127.0.0.1` and
  therefore nowhere at all for a browser on another machine.
- **Where credentials live**: one 0600 JSON file next to the plugin database,
  never in SQLite and never in an RPC response. A corrupt file means "sign in
  again", not a failed load.
- **A hand-registered client**, per server, for providers that do not support
  dynamic registration, with its scopes and secret.

The redirect lands on the **panel**, at
`<origin>/plugins/mcp-hub/mcp-hub/oauth/callback`, not on the plugin's public
HTTP route: BB Connect answers `/api/...` with 401 and a login page, which
throws the authorization code away, while a panel URL is an ordinary app URL.
The code is then exchanged over the panel's authenticated `oauth_resolve` /
`oauth_complete` RPC.

## The other MCP source

Claude Code loads the connectors attached to the signed-in claude.ai account on
its own, outside anything this plugin selects - twelve of them have been
measured at roughly 188k prompt tokens a session. **Settings -> Plugins -> MCP
Hub -> Disable claude.ai connectors** sets `ENABLE_CLAUDEAI_MCP_SERVERS=0` on
every Claude Code thread this plugin runs in. It is off by default, because the
plugin does not own your provider configuration.

It does not reach servers you wrote into `~/.claude.json` yourself (the only
lever there is `--strict-mcp-config`, which BB never passes), and Codex has no
environment variable for this: set `[features] apps = false` in
`~/.codex/config.toml` by hand, once.

## Upgrading from 0.1

`src/storage/legacy.ts` imports the old tables once - servers, their tools,
OAuth grants, dynamically registered clients, headers and environment - and
moves credentials into the secrets file. It runs on the first load after the
upgrade and records that it ran, so deleting every server later cannot
resurrect the old list. The old tables are left in place as a fallback.

## Layout

- `server.ts` - wiring only: migrations, the one-time import, the stack
  (store -> connections -> tool surfaces -> hub), and the four surfaces.
- `src/storage/` - `schema.ts` (append-only migrations), `store.ts` (servers,
  tools, call log), `secrets.ts` (0600 file), `legacy.ts` (the import).
- `src/mcp/` - `stdio.ts`, `http.ts`, `connection.ts`, `execute.ts`,
  `validate.ts`, `content.ts`, `oauth.ts`, `naming.ts`.
- `src/server/` - `hub.ts` (the domain layer), `selection.ts`, `tools.ts`,
  `rpc.ts`, `cli.ts`, `services.ts`, `provider-env.ts`, `log.ts`.
- `src/ui/` - `panel.tsx`, `server-form.tsx`, `server-detail.tsx`,
  `tool-test.tsx`, `footer.tsx`, `data.ts`, `rpc.ts`.
- `contract.ts` - the RPC contract both sides compile against.
- `skills/mcp-hub/SKILL.md` - what agents are told.

## CLI

```sh
bb mcp-hub                          # servers, status, tool counts
bb mcp-hub list --tools             # and every tool
bb mcp-hub sync <server>            # reconnect and reread one server
bb mcp-hub test <server>            # connect and report what it answers
bb mcp-hub call <server> <tool> --args '{"query":"x"}'
```

## Development

```bash
npm install
npm run verify   # lint, typecheck, tests, build
bb plugin install . --yes
bb plugin reload mcp-hub
```

`npm run verify` must pass before a commit. `bb plugin build` writes
`dist/server.js`, `dist/app.js`, and `dist/app.css`.

Tests run against real MCP servers as child processes (`tests/fixtures/`), not
mocks: the point of most of them is what the wire actually does when a server
refuses a call or changes its tool list.

`components/ui/` is vendored source this plugin owns (the shadcn model): edit
the files freely - they never update out from under you. React and the
BB-shimmed packages (the Radix portal primitives, `sonner`) are provided by the
BB app at runtime and stay in `devDependencies`; everything else that is
bundled belongs in `dependencies`.
