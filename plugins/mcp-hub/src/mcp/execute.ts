// One tool call: validate, connect, send, translate, record.
//
// Every failure mode gets its own answer instead of one generic error. A bad
// argument names the field; a JSON-RPC error quotes the server's code and
// message; a dead grant says to reconnect; a dead pipe is retried once for a
// read-only tool and never for a write, because a write that may have landed
// must not land twice.
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerRecord, ToolRecord } from "../storage/store.js";
import { translateResult, type TranslatedResult } from "./content.js";
import { isProtocolError, type ConnectionManager } from "./connection.js";
import { checkArguments } from "./validate.js";

export interface ExecuteOutcome {
  result: TranslatedResult;
  durationMs: number;
  /** Set when the call did not reach the server or the server refused it. */
  failure: string | null;
  /** True when the grant is dead and only a new sign-in will fix it. */
  needsAuth: boolean;
}

export interface ExecuteDeps {
  connections: ConnectionManager;
  now?: () => number;
}

function messageOf(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message) {
    return `${(error as Error).message}: ${cause.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError) return error.code === 401 || error.code === 403;
  return false;
}

function failed(message: string, durationMs: number, needsAuth = false): ExecuteOutcome {
  return {
    result: { content: [{ type: "text", text: message }], isError: true },
    durationMs,
    failure: message,
    needsAuth,
  };
}

/**
 * Calls one tool on one server.
 *
 * `arguments` is whatever the model sent. It is checked against the schema the
 * server advertised at its last sync, which is the schema the model was shown.
 */
export async function executeTool(
  deps: ExecuteDeps,
  request: {
    server: ServerRecord;
    tool: ToolRecord;
    arguments: unknown;
    origin?: string;
  },
): Promise<ExecuteOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { server, tool } = request;

  if (!server.enabled) {
    return failed(
      `The MCP server "${server.name}" is turned off in the MCP settings, so "${tool.upstreamName}" was not called.`,
      0,
    );
  }

  const checked = checkArguments(tool.inputSchema, request.arguments);
  if (!checked.ok) {
    return failed(`${checked.message}. The tool was not called.`, now() - started);
  }

  async function send(): Promise<CallToolResult> {
    const connection = await deps.connections.ensure(server, { origin: request.origin });
    return (await connection.client.callTool({
      name: tool.upstreamName,
      arguments: checked.ok ? checked.arguments : {},
    })) as CallToolResult;
  }

  try {
    const raw = await send();
    return {
      result: translateResult(raw),
      durationMs: now() - started,
      failure: null,
      needsAuth: false,
    };
  } catch (error) {
    // A protocol error is the server doing its job: report it and keep the
    // connection, because other threads may be using it this second.
    if (isProtocolError(error)) {
      const text = `The server refused the call: ${error.message} (code ${error.code}).`;
      return failed(text, now() - started);
    }

    if (isUnauthorized(error)) {
      const text = `"${server.name}" needs you to sign in again. Open the MCP settings and press Connect.`;
      await deps.connections.markNeedsAuth(server.id, messageOf(error));
      return failed(text, now() - started, true);
    }

    // Anything else is a transport failure. Drop the dead client so the next
    // call reconnects, and retry once - but only for a read, never for a
    // write that may already have been applied.
    await deps.connections.close(server.id);
    if (!tool.readOnly) {
      return failed(
        `The connection to "${server.name}" failed: ${messageOf(error)}. The call may or may not have run; it was not retried because it is not marked read-only.`,
        now() - started,
      );
    }

    try {
      const raw = await send();
      return {
        result: translateResult(raw),
        durationMs: now() - started,
        failure: null,
        needsAuth: false,
      };
    } catch (retryError) {
      if (isUnauthorized(retryError)) {
        await deps.connections.markNeedsAuth(server.id, messageOf(retryError));
        return failed(
          `"${server.name}" needs you to sign in again. Open the MCP settings and press Connect.`,
          now() - started,
          true,
        );
      }
      return failed(
        `The connection to "${server.name}" failed: ${messageOf(retryError)}`,
        now() - started,
      );
    }
  }
}
