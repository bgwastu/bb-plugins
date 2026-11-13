// The wire contract between server.ts (`bb.rpc.register`) and app.tsx
// (`useRpc`). Both sides import from here, so a schema change fails to compile
// on whichever side did not follow.
//
// The panel never receives a credential: every secret field here is
// write-only, and the views say only whether one is stored.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Realtime channel published after every mutation; clients refetch on it. */
export const MCP_CHANGED = "mcp-changed";

export const transportSchema = z.enum(["stdio", "http"]);
export const authSchema = z.enum(["none", "bearer", "headers", "oauth"]);
export const connectionStateSchema = z.enum(["idle", "connecting", "ready", "needs-auth", "failed"]);

export type McpTransport = z.infer<typeof transportSchema>;
export type McpAuth = z.infer<typeof authSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;

/**
 * Where the OAuth redirect lands: the plugin's own panel, not its public API
 * route. BB is reachable at several origins and some sit behind a sign-in,
 * which answers an `/api/...` callback with a login page and throws the code
 * away. A panel URL is an ordinary app URL. Shared so the panel and the server
 * compose the same string - an authorization server compares it byte for byte.
 */
export const OAUTH_CALLBACK_SUBPATH = "oauth/callback";
export const MCP_PANEL_ROUTE = "/plugins/mcp-hub/mcp-hub";

export function oauthRedirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_PANEL_ROUTE}/${OAUTH_CALLBACK_SUBPATH}`;
}

export const toolProblemSchema = z.object({
  name: z.string(),
  reason: z.string(),
});
export type ToolProblem = z.infer<typeof toolProblemSchema>;

export const serverViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: transportSchema,
  url: z.string().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  auth: authSchema,
  oauthClientId: z.string().nullable(),
  oauthScopes: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  /** What is stored, never the value. */
  hasBearer: z.boolean(),
  hasHeaders: z.boolean(),
  hasEnv: z.boolean(),
  hasOAuthClientSecret: z.boolean(),
  /** The redirect URI this browser would use, when an origin is known. */
  redirectUri: z.string().nullable(),
  /** The URI a stored client was registered with, when it differs. */
  registeredRedirectUri: z.string().nullable(),
  state: connectionStateSchema,
  protocol: z.enum(["stdio", "http", "sse"]).nullable(),
  toolCount: z.number().nullable(),
  error: z.string().nullable(),
  authorizationUrl: z.string().nullable(),
});
export type ServerView = z.infer<typeof serverViewSchema>;

export const toolViewSchema = z.object({
  serverId: z.string(),
  name: z.string(),
  upstreamName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  readOnly: z.boolean(),
  enabled: z.boolean(),
  missing: z.boolean(),
  /** Set when BB refused to register the tool, with the reason. */
  problem: z.string().nullable(),
});
export type ToolView = z.infer<typeof toolViewSchema>;

export const snapshotSchema = z.object({
  servers: z.array(serverViewSchema),
  tools: z.array(toolViewSchema),
  problems: z.array(toolProblemSchema),
  /** Every tool a session would offer right now, before the 256 cap. */
  offered: z.number(),
  truncated: z.boolean(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const serverInputSchema = z.object({
  /** Absent when adding. */
  id: z.string().optional(),
  name: z.string().min(1),
  transport: transportSchema,
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()),
  cwd: z.string().optional(),
  auth: authSchema,
  /** Write-only. Omitted means "leave what is stored"; `""` clears it. */
  bearer: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthScopes: z.string().optional(),
  enabled: z.boolean(),
  /** Connect as part of saving, so a wrong URL fails here and not later. */
  connect: z.boolean(),
  /** The origin the browser is on, for the OAuth redirect URI. Never stored. */
  origin: z.string().optional(),
});
export type ServerInput = z.infer<typeof serverInputSchema>;

export const callSchema = z.object({
  id: z.number(),
  at: z.number(),
  serverId: z.string(),
  tool: z.string(),
  threadId: z.string().nullable(),
  ok: z.boolean(),
  durationMs: z.number(),
  error: z.string().nullable(),
});
export type CallView = z.infer<typeof callSchema>;

export const toolResultSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
  isError: z.boolean(),
  durationMs: z.number(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

const empty = z.object({});

export const contract = defineRpcContract({
  snapshot: {
    input: z.object({ origin: z.string().optional() }),
    output: snapshotSchema,
  },

  server_create: {
    input: serverInputSchema,
    output: z.object({ id: z.string(), authorizationUrl: z.string().nullable(), error: z.string().nullable() }),
  },

  server_update: {
    input: serverInputSchema,
    output: z.object({ id: z.string(), authorizationUrl: z.string().nullable(), error: z.string().nullable() }),
  },

  server_remove: {
    input: z.object({ id: z.string() }),
    output: empty,
  },

  server_enabled: {
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: empty,
  },

  server_connect: {
    input: z.object({ id: z.string(), origin: z.string().optional() }),
    output: z.object({
      state: connectionStateSchema,
      authorizationUrl: z.string().nullable(),
      tools: z.number(),
      error: z.string().nullable(),
    }),
  },

  /** Which server a callback's `state` belongs to, so the code is not offered
   * to the wrong token endpoint. */
  oauth_resolve: {
    input: z.object({ state: z.string() }),
    output: z.object({ id: z.string().nullable() }),
  },

  /** Finishes an OAuth flow the browser came back from. */
  oauth_complete: {
    input: z.object({ id: z.string(), code: z.string(), origin: z.string().optional() }),
    output: z.object({ tools: z.number(), error: z.string().nullable() }),
  },

  tool_enabled: {
    input: z.object({ names: z.array(z.string()), enabled: z.boolean() }),
    output: z.object({ updated: z.number() }),
  },

  /** The Test button: call a tool with the arguments from a schema-built form. */
  tool_call: {
    input: z.object({ serverId: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }),
    output: toolResultSchema,
  },

  calls: {
    input: z.object({ serverId: z.string(), limit: z.number().int().min(1).max(200) }),
    output: z.object({ calls: z.array(callSchema) }),
  },

  /**
   * Stops the thread so its next message starts a session with the current
   * switches. `interrupt` does it now even mid-turn; otherwise the stop waits
   * for the turn to end.
   */
  restart_thread: {
    input: z.object({ threadId: z.string(), interrupt: z.boolean() }),
    output: z.object({ restarted: z.boolean(), deferred: z.boolean() }),
  },
});

export type McpContract = typeof contract;
