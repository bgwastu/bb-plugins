# MCP Hub (bb-plugin-mcp-hub)

> Fork of [vojtad/bb-plugin-mcp](https://github.com/vojtad/bb-plugin-mcp) (initial commit 6eab202, 2026-09-19).
> Upstream publishes no license. Changes here: the plugin id, panel route, `bb mcp-hub` CLI and
> skill are renamed from `mcp` so they coexist with bb's built-in `bb--mcp` plugin (`bb mcp`).
> The AI planning docs under `docs/superpowers/` were not copied.


Connect MCP servers to BB - local stdio processes and remote endpoints, on
OAuth or on a static token in a request header - and use their tools in every
thread.

A connected server's tools are registered as ordinary BB agent tools under the
name the server gives them, so every provider BB supports can call them without
knowing MCP exists. A name two servers both want gets a `<server>_` prefix on
whichever asked second, and that resolved name is then persisted and never
reassigned. Tools the server does not mark read-only prompt the user for
confirmation before they run.

## Connection types

The panel asks what you are adding, not how BB should speak to it:

- **Local command** - a program BB runs on this machine and talks to over
  stdio.
- **Remote MCP server** - a hosted endpoint, signed into with OAuth or
  authenticated with a static header.
- **Gateway (Executor)** - one endpoint in front of many integrations. A
  handful of tools reach everything connected there, so the tool count stays
  small and the *descriptions* are what change as integrations are added -
  which is why the panel has a Reload button. See "Tools that changed".

Each type shows only the fields it needs; headers, OAuth client credentials,
environment and working directory sit behind one Advanced disclosure. A
server's row carries one action - Connect, Reconnect or Test - and everything
else lives in its Settings dialog.

`kind` is stored, but nothing branches on it: a gateway is Streamable HTTP like
any other remote server, and gateway behaviour is still DETECTED from a tool's
description (`src/server/gateway.ts`). The kind is what the form asks for and
what a row is labelled with.

## The only MCP source

A provider also loads MCP servers of its own accord, which arrive alongside
this plugin's tools and outside its per-project selection. Twelve claude.ai
connectors cost ~188k prompt tokens; the panel cannot make that cheaper.

So the plugin sets `ENABLE_CLAUDEAI_MCP_SERVERS=0` on every Claude Code thread
it runs in. This is unconditional and there is no setting for it.

Two things it does not cover:

- Servers you wrote into `~/.claude.json` yourself. The only lever over those
  is `--strict-mcp-config`, and BB drives Claude Code through the Agent SDK
  and never passes it.
- Codex. It has no environment variable for this, and contributed environment
  would not reach it anyway - BB maps it to `shell_environment_policy.set.*`,
  which is the environment for shell commands the agent runs, not the codex
  process. Switch it off by hand, once, in `~/.codex/config.toml`:

  ```toml
  [features]
  apps = false
  ```

  That is the account-connector switch, the counterpart of the Claude Code
  one. It leaves `features.plugins` alone, it applies to Codex everywhere and
  not only inside BB, and it does not touch literal `[mcp_servers.*]` entries.

## Layout

- `server.ts` - wiring only. Opens the database, builds the stack
  (registry -> stdio supervisor -> client pool -> catalog), registers the
  agent tools from the *cached* catalog, and exposes the registry over RPC.
  Nothing on the load path talks to an MCP server or waits on the project list.
- `src/storage/` - the SQLite registry (servers with their OAuth client
  configuration and their static request headers, catalog, per-project
  overrides) and the OAuth token store.
- `src/mcp/` - the client pool, the stdio supervisor, transports, JSON Schema
  flattening, content translation, and tool naming.
- `src/oauth/` - discovery, dynamic client registration, PKCE, and the token
  lifecycle.
- `src/server/` - the surfaces: agent tools, RPC, HTTP routes, per-project
  tool selection, the provider environment, the CLI, and the background
  schedule.
- `src/ui/` - the connections panel and the consent prompt.
- `skills/mcp/SKILL.md` - what agents are told about MCP tools.

## Signing in

The redirect URI is built from the origin the panel is being served from, at
the moment Connect is pressed - never from `bb.server.loopbackBaseUrl`, which
is `127.0.0.1` and therefore nowhere at all for a browser on another machine.
One BB answers on several origins at once (a tailnet name, a BB Connect tunnel,
loopback), and only the browser doing the authorizing knows which it is on.

The redirect lands on the **panel**, at
`<origin>/plugins/mcp-hub/mcp-hub/oauth/callback`, rather than on the plugin's public
HTTP route. That is what makes it work on an origin sitting behind a sign-in:
BB Connect answers `/api/...` with 401 and a login page, which throws the
authorization code away, while a panel URL is an ordinary app URL. The code is
then exchanged over the panel's authenticated `oauth_complete` RPC, so the
public route is no longer on the critical path - it stays only as the fallback
for a shell with no http(s) origin to offer.

One consequence worth knowing: connecting from a second origin registers a
different redirect URI. That is free under dynamic client registration and not
free for a client you created by hand, where both URIs have to be listed in the
provider. The Settings dialog shows the URI this browser would use next to the
one the stored client was registered with, and says so when they differ.

## When credentials die

A refresh that is refused outright, or a 401 that survives one, is recorded
against the server and shown in three places: a banner at the top of the panel,
the server's own row, and `bb mcp-hub list`. The plugin also marks itself
`needs-configuration`, which reaches `bb plugin list` and the BB UI without the
panel being open.

This exists because the silent version ran for four days: Cloudflare Access
ended a grant at its 24-hour **Grant session duration**, the refresh came back
`400 invalid_grant`, and the only record was one line in a log file while the
background sweep re-failed every seventeen minutes. A dead grant is now backed
off to once an hour, and the message quotes what the authorization server
actually said - plus, for a `*.cloudflareaccess.com` token endpoint, the
setting that is really ending it. Reconnecting there buys another 24 hours and
nothing else; raising Grant session duration in Zero Trust is the fix.

## Tools that changed

`registerTool` has no update and no unregister, so a description or schema
that moves after a name was claimed reaches nobody - the panel's own Sync
button included. Adding one integration to a gateway moves nothing but one
tool's description, so this is the normal way a gateway's catalog changes
rather than a rare event.

The panel therefore counts the drifted tools and offers a **Reload plugin**
button, which is the only thing that fixes it (`bb plugin reload mcp` does the
same from a shell). Deliberately a button and never automatic: a reload
cancels every tool-approval prompt waiting on every thread, which is not
something to do to someone who did not ask for it.

## What agents are told

Two surfaces, neither of which the user has to write:

- `skills/mcp/SKILL.md` - how MCP tools work here, what a gateway is, what the
  consent prompt means, and what each failure message is asking for.
- Dynamic instructions from `bb.agents.configure`, rebuilt on every sync,
  naming each connected gateway and the services it reaches. A provider that
  defers a tool to a bare name and loads its description only on a keyword
  search will never match "notion" against a tool called `execute`, so the
  integrations are stated up front along with the exact-name load
  (`ToolSearch select:mcp__bb-bridge__execute`) that retrieves the rest.

## Design invariants

- **The load path never blocks on a server.** Tools are registered from the
  cached catalog. Discovery happens in `catalog.sync`, driven by an explicit
  RPC or the background refresh.
- **Registered names are permanent.** A name is assigned at first sync and
  never reassigned, so a thread's history keeps meaning after a rename.
- **A default reaches every project; a project may disagree.** A tool marked
  default-on is offered everywhere, and a project's binding row is an override
  on top of it - force-on or force-off - so what a project gets is
  `defaults - forcedOff + forcedOn`. Storing the projects that disagree rather
  than a project-to-names map is what lets a default reach a project created a
  second ago, and it keeps the project list off the load path.
- **This plugin is the MCP source.** Claude Code threads run with
  `ENABLE_CLAUDEAI_MCP_SERVERS=0`, contributed per thread. A tool the panel
  did not offer should not be in the session.
- **A gateway's services are named in words.** A description that lists the
  integrations behind it as slugs - a bullet list of bare `notion_com` - is
  registered with those slugs repeated as words. A provider may defer a tool
  to a bare name and load its description only when the model searches for
  it, and that search matches whole words, so without this an agent asked
  about Notion finds nothing and reports that nothing offers Notion.
  `bb mcp-hub list` prints the same list for a shell.
- **Writes ask.** BB puts plugin tools into the provider's allow list and no
  provider will ask on this plugin's behalf, so the consent gate is the only
  thing between an agent and a silent write.
- **A write is never replayed.** A 401 buys one refresh and one retry for a
  read-only tool. A write that fails is reported, not repeated.
- **A live connection never carries a stale bearer.** The HTTP transport
  resolves its auth header per REQUEST, through a `fetch` of its own, rather
  than baking one into `requestInit` at construction. A pooled client outlives
  several access tokens and cannot be corrected from outside, so this is the
  only place the refresh can reach.
- **The callback host is whatever the browser is on.** Detected client-side at
  connect time, and it lands on the panel so that an origin behind a sign-in
  works too.
- **Dispose reaps everything.** `bb.onDispose` closes every pooled MCP client
  and kills every stdio child; dispose hooks run before BB drains in-flight
  invocations, so it is the only place that reliably gets them.

## Background work

One durable cron schedule, `catalog-refresh`, re-reads every enabled server's
tool list every 17 minutes and registers whatever is new. A connected stdio
child persists across cycles, so N stdio servers cost N long-lived processes,
not N spawns every 17 minutes.

A sync only ever *adds* names, for the reason under "Tools that changed"; the
panel and `bb mcp-hub list` mark a row that has moved since it was registered.

The same cycle first warms tokens, and its job is not freshness but
visibility. Tokens stay fresh on their own: `OAuthFlow.accessToken` refreshes
at three quarters of the quoted lifetime and the HTTP transport calls it on
every request, so a token that went stale while a pooled client sat idle is
renewed before the request that needed it - which is also why a write against
such a client no longer fails once, as it used to. Refreshing on a schedule is
how a grant that DIED is discovered while nobody is waiting on an answer,
turning it into a recorded, surfaced error within seventeen minutes rather than
into whatever tool call happens to be first in the morning.

## Development

```bash
npm install
npm run verify   # lint, typecheck, tests, build
bb plugin install . --yes
bb plugin reload mcp
```

`npm run verify` must pass before a commit. `bb plugin build` writes
`dist/server.js`, `dist/app.js`, and `dist/app.css`.

`bb mcp-hub` lists the configured servers and their tools from a shell.

## UI components

`components/ui/` is vendored source this plugin owns (the shadcn model): edit
the files freely - they never update out from under you. Add more from the BB
component registry:

```
npx shadcn add @bb/select @bb/table
```

React and the BB-shimmed packages (the Radix portal primitives, `sonner`) are
provided by the BB app at runtime and stay in `devDependencies`; everything
else that is bundled belongs in `dependencies`.
