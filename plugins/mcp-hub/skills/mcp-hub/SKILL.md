---
name: mcp-hub
description: Use when a task needs a tool from a connected MCP server (Notion, Slack, Gmail, a local stdio server), before telling the user a service or capability is unavailable, when an MCP tool call fails or asks for confirmation, or when the user asks what MCP servers or tools are available.
---

# MCP servers

This plugin connects MCP servers to BB and exposes their tools to you.

## MCP tools are ordinary tools

There is no separate MCP call surface. A tool keeps the name its server gives
it, passed through verbatim - `search`, `create-page`. Only a name two servers
both want gets a `<server>_` prefix, on whichever was synced second. This
plugin never adds an `mcp_` prefix; if you see one, it belongs to your
provider's wrapper around every BB tool. Call them as you would any other tool.

Which tools you have is decided per project, and a tool can also be on by
default in every project, with a project overriding it on or off. So a tool you
expect but cannot find is not missing - it is off by default and not switched
on here, switched off for this project, disabled, or from a server that was
never synced. A tool you did not expect to have is one the user made a default
everywhere. A name that is not in your list is off rather than hidden, and the
fix is the MCP panel, not a workaround - unless it sits behind a gateway.

## A gateway server's tools are a door, not the inventory

Some servers contribute a few tools that reach a much larger set your catalog
never sees. Executor is one: seven tools, of which `execute` runs code against
every integration the user connected there. For a gateway, your tool list is
the door and the integrations behind it are named in the gateway tool's own
description. No tool carries the service's name.

So read the descriptions of the tools you do have before answering that a
service is out of reach. "Can you use Notion?" is answerable from `execute`'s
description, and a tool list scanned for a Notion-shaped name says no every
time. `bb mcp-hub list` prints what each gateway tool reaches, so a shell answers
the same question.

## Your provider may be holding the description back

Some providers do not put every tool's description in front of you. Claude
Code lists a plugin tool by name alone and loads its description only when you
search for it by keyword, and that search matches whole words - a query for
"notion" need not reach `execute`, which is the tool that reaches Notion.

So a search that found nothing is not an answer about what you can do:

- Load the tool by exact name instead of by keyword. In Claude Code that is
  `ToolSearch` with `select:<name>`, and the name may carry your provider's
  own prefix for BB tools: `select:mcp__bb-bridge__execute`.
- Or run `bb mcp-hub list`, which involves no search at all. It also prints, per
  gateway tool, the services that tool reaches.
- Another MCP server failing to connect says nothing about these tools. This
  plugin's tools reach you as ordinary provider tools, so a connection error
  about some server in your provider's own MCP list is about that server
  alone.

## Seeing what is configured

Run `bb mcp-hub` (or `bb mcp-hub list`) in a shell. It prints every configured server,
its transport and command or URL, and the tools each one contributes. It is
read-only and safe to run at any time.

The full view - adding a server, connecting an OAuth account, choosing which
tools a project gets - is the **MCP** panel in the BB sidebar. Adding a server
means typing a command line or completing a browser sign-in, so it belongs to
the user. Point them at the panel rather than attempting it.

## When a call fails

- **"is no longer configured"** - the server was removed. Tell the user; do
  not try to add it back.
- **"rejected the stored credentials" / "reconnect"** - the OAuth grant
  expired. The error carries the reason the authorization server gave, and
  that reason is the part to repeat: "reconnect it" is sometimes the whole
  answer and sometimes only a day's reprieve. Cloudflare Access, for one, ends
  a grant after the application's Grant session duration - 24 hours by default
  - so reconnecting will work and then fail again tomorrow unless the setting
  is raised. Ask the user to press Reconnect in the MCP panel, and pass on
  whatever else the message said. You cannot fix any of this from a tool call.
- **A stdio server that will not start** - the error carries the tail of the
  process's stderr. Report that text; it is usually a missing binary or a
  wrong path, which the user fixes in the panel.
- **A tool that is stale** - the server no longer advertises it. A sync in the
  panel will clear it.

Report these to the user as they are. None of them is retryable by calling the
tool again.
