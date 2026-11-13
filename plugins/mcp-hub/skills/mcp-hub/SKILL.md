---
name: mcp-hub
description: Use when a task needs a tool from a connected MCP server (Notion, Linear, Slack, a local server), before telling the user a service is unavailable, when an MCP tool call fails or is refused, or when the user asks which MCP servers or tools are available.
---

# MCP tools

MCP servers are connected through the MCP Hub plugin, and their tools are your
tools. There is no separate MCP call surface: you call `linear_create_issue`
directly, exactly as you would call any other tool.

## Names

Every tool is named `<server>_<tool>` - the server's id, an underscore, and the
name the server itself gave the tool. `composio_GMAIL_SEND_EMAIL` is the
`GMAIL_SEND_EMAIL` tool on the server whose id is `composio`. If your provider
wraps BB tools in its own prefix (`mcp__...`), that prefix belongs to the
provider, not to this plugin.

A name is assigned once and never changes, so a tool named in an earlier turn
still means the same thing later.

## A tool you cannot find

Servers are switched on or off for everyone, and each tool has its own switch.
Your session carries whatever was on when it started, so a tool the user
expects and you do not have means one of:

- the server is off, or the tool is off, in the MCP settings;
- the server has not been connected yet;
- the server is waiting for a sign-in;
- the switch was turned on after your session started - it arrives after a
  restart, which the MCP popup offers.

Do not infer that a capability does not exist from a missing tool name. Say
which server and tool you would need, and that it is off or not connected - the
fix is in the MCP settings, not a workaround.

## A tool that is present but refuses

Switching a server or tool off is immediate, even in a session that already has
it:

> The MCP server "composio" is turned off, so "composio_..." was not called.

That is not a failure to work around. Tell the user it is switched off and
where the switch is.

## When a call fails

The message tells you which kind of failure it is, and they need different
answers:

- **"Invalid arguments: arguments.x ..."** - the call never reached the server.
  Fix the argument and call again. The schema you see is the tool's own.
- **"The server refused the call: ... (code N)"** - the server answered with an
  error. That is its own answer, about the call, not a broken connection. Read
  the message; changing the arguments often fixes it.
- **"needs you to sign in again"** - the connection is fine and the credential
  is not. Tell the user to open the MCP settings and press Connect on that
  server. Nothing you can do from a tool call fixes it.
- **"The connection to ... failed"** - the transport died. A read-only call is
  retried once automatically. A write is not retried: it may have run, so say
  so rather than repeating it.

Never retry a write that reported a connection failure without asking the user
first.

## What a gateway is

Some servers are gateways: a few tools that reach a much larger set of
integrations the catalog never lists. Executor is one - its `execute` tool runs
code against every integration the user connected there. For a gateway, your
tool list is the door, and the integrations behind it are named in the tool's
own description. Read the description before answering that a service is out of
reach.

## Which servers and tools exist right now

`bb mcp-hub` lists them from a shell, with `--tools` for every tool. That answer
is the same state the panel shows, so it is not narrower than yours unless your
session predates a switch.
