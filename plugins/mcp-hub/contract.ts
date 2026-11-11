// The wire contract between server.ts (bb.rpc.register) and app.tsx
// (useRpc). Both sides import from here, so a schema change is a compile
// error on whichever side did not follow.
//
// Every input is a zod object with no optional-but-present keys: the RPC
// boundary is strict JSON, so a caller omits a key rather than sending
// `undefined` for it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Realtime channel published after every mutation. Signals are ephemeral and
 * never replayed, so the panel refetches on this AND on every
 * reconnecting -> connected transition.
 */
export const MCP_CHANGED = "mcp-changed";

export const transportSchema = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof transportSchema>;

/**
 * What a connection IS, which is the question the panel asks. The transport is
 * how it is spoken to, which is the answer that follows from it.
 *
 * A gateway - Executor and its kind - is Streamable HTTP like any other remote
 * server, so no code branches on this. It exists because "a gateway" and "an
 * MCP server" are different things to the person adding one, and a form that
 * asks for a transport enum makes the user do that translation.
 */
export const serverKindSchema = z.enum(["local", "remote", "gateway"]);
export type McpServerKind = z.infer<typeof serverKindSchema>;

/** A gateway is a remote server; only a local command is stdio. */
export function transportForKind(kind: McpServerKind): McpTransport {
  return kind === "local" ? "stdio" : "http";
}

/**
 * Where the OAuth redirect lands: this plugin's own panel, under the BB app.
 *
 * NOT the plugin's `auth: "none"` HTTP route, and that is the whole point. BB
 * is reachable at more than one origin and some of them are session-gated - BB
 * Connect answers `/api/...` with 401 and a login page - so a callback aimed
 * at the API route throws the authorization code away on exactly the origins a
 * remote user is most likely to be on. A panel URL is an ordinary app URL: it
 * works signed in, it works when there is nothing to sign in to, and the code
 * is exchanged over the panel's authenticated RPC rather than by a public
 * route guarded only by a nonce.
 */
export const OAUTH_CALLBACK_SUBPATH = "oauth/callback";

/**
 * This plugin's nav panel route, `/plugins/<pluginId>/<panel path>`. Both
 * segments are "mcp-hub" here - the plugin id and the panel's own `path` in
 * app.tsx - and the panel component receives everything after them as
 * `subPath`.
 */
export const MCP_PANEL_ROUTE = "/plugins/mcp-hub/mcp-hub";

/**
 * The redirect URI for one origin. Shared so the panel and the server compose
 * the same string: an authorization server compares it byte for byte against
 * the registered one, and two builders drifting apart is a flow that fails at
 * the last step with nothing to read.
 */
export function oauthRedirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_PANEL_ROUTE}/${OAUTH_CALLBACK_SUBPATH}`;
}

/**
 * Where a remote server's OAuth stands. Mirrors `AuthStatus` in
 * src/oauth/flow.ts; declared here so the panel never imports a server module.
 */
export const authStatusSchema = z.enum(["disconnected", "connected", "needs-reconnect"]);

/**
 * Whether this server is authenticated by a header the user typed rather than
 * by a grant this plugin minted.
 *
 * `Authorization` specifically, because that is the header an OAuth bearer
 * occupies: a server carrying its own is not a server waiting to be connected.
 * Other headers - routing, an api version - say nothing about how it
 * authenticates. A configured OAuth client outranks the header either way,
 * since asking for OAuth explicitly is the one unambiguous signal there is.
 *
 * Shared rather than written twice: the panel decides what to offer and the
 * RPC decides what to refuse, and the two disagreeing would put a button in
 * front of the user that answers with an error.
 */
export function isHeaderAuthenticated(server: {
  headers: Record<string, string>;
  oauthClientId: string | null;
}): boolean {
  if (server.oauthClientId !== null) return false;
  return Object.keys(server.headers).some((name) => name.toLowerCase() === "authorization");
}
export type McpAuthStatus = z.infer<typeof authStatusSchema>;

/**
 * A character no header value may carry. Written as a loop rather than a
 * regex: a control character inside a character class is invisible in the
 * source and lints as a mistake.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Extra HTTP headers sent on every request to a remote server, for the many
 * servers that authenticate with a static token rather than OAuth.
 *
 * Names are RFC 7230 tokens and values carry no control characters. The value
 * rule is the load-bearing one: a token pasted with a trailing newline would
 * otherwise be spliced into the request as a header of its own.
 */
export const headersSchema = z.record(
  z.string().regex(
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
    "a header name may only contain letters, digits and !#$%&'*+-.^_`|~",
  ),
  z.string().refine(
    (value) => !hasControlCharacter(value),
    "a header value may not contain control characters, including newlines",
  ),
);

/** A configured server as the panel sees it. */
export const serverSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  transport: transportSchema,
  kind: serverKindSchema,
  url: z.string().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string().nullable(),
  /**
   * Extra request headers, http only, `{}` when none are set.
   *
   * Values come back as they were typed, unlike the OAuth client secret. A
   * header is the same kind of thing as a stdio server's `env`, which has
   * always round-tripped in full and is where the equivalent token lives for a
   * local server; hiding one of the pair would only make the header
   * uneditable.
   */
  headers: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  createdAt: z.number(),
  /**
   * `null` for a stdio server, which has no OAuth to be in a state about.
   * Nullable rather than optional: an output DTO with an absent key and one
   * with a null key are the same value to a reader, and only one of them can
   * be told apart from a field the server forgot to fill in.
   */
  authStatus: authStatusSchema.nullable(),
  /**
   * Every tool from this server prompts, whatever its `readOnlyHint` says and
   * whatever the user clicks (design section 12.1). Reported so the panel can
   * explain why those switches are not offered rather than leaving the user to
   * wonder why the prompts never stop.
   */
  alwaysAsk: z.boolean(),
  /** An OAuth client the user created themselves, `null` when none is saved. */
  oauthClientId: z.string().nullable(),
  /**
   * Whether a client secret is stored. The secret itself is NEVER returned:
   * the panel only has to decide between "type one" and "one is already
   * saved", and a DTO that carried it would put it in every panel payload,
   * every browser devtools network tab and every log of one.
   */
  hasOauthClientSecret: z.boolean(),
  /** The scope string exactly as the user typed it. */
  oauthScopes: z.string().nullable(),
  /**
   * Why this server's credentials stopped working, and since when.
   *
   * Separate from `authStatus`: the status says a reconnect is owed, this says
   * what happened, and only the second one can tell a user that Cloudflare
   * Access ended the grant at its 24-hour limit rather than that BB broke.
   */
  authError: z.object({ message: z.string(), at: z.number() }).nullable(),
  /**
   * The redirect URI the stored OAuth client was registered with, or `null`
   * when no client is stored. The panel compares it with the one THIS browser
   * would use and explains the difference, because connecting from a second
   * origin silently re-registers - free under dynamic registration, not free
   * for a client the user made by hand.
   */
  registeredRedirectUri: z.string().nullable(),
});
export type McpServerDto = z.infer<typeof serverSchema>;

/**
 * One catalog row. The input schema itself is deliberately absent: the panel
 * only needs its size (schemas are the whole cost of an MCP connection, see
 * design section 8b), and a full schema per tool would make this response
 * hundreds of kilobytes. A row the user opens fetches its own via
 * `tool_details`.
 */
export const toolSchema = z.object({
  serverId: z.string(),
  upstreamName: z.string(),
  registeredName: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  ask: z.boolean(),
  /**
   * Available in every project that has not overridden it off, so the panel
   * can show a tool as reachable in a project whose checkbox nobody ticked.
   */
  defaultEnabled: z.boolean(),
  stale: z.boolean(),
  /**
   * The row has moved since the host registered this name, so the model is
   * still being shown the previous description or schema. A sync cannot fix
   * it - `registerTool` has no update and no unregister - so the panel says a
   * reload is owed.
   */
  driftedFromRegistration: z.boolean(),
  syncedAt: z.number(),
  schemaBytes: z.number(),
  /**
   * What this tool costs a context window, roughly. Exact bytes are already
   * here and stay here, but nobody budgets a context window in bytes, and the
   * schema is the whole of what an MCP connection spends. Always rendered with
   * a `~`: the divisor behind it is calibrated, not authoritative (see
   * CHARS_PER_TOKEN in src/server/rpc.ts).
   */
  estimatedTokens: z.number(),
});
export type McpToolDto = z.infer<typeof toolSchema>;

/**
 * One parameter of a tool, flattened out of its JSON Schema.
 *
 * Flattened here rather than in the panel because the schema is the backend's
 * data: the panel reads what a tool takes, and a JSON Schema walker in a
 * render path would make every provider's dialect the UI's problem.
 */
export const toolParameterSchema = z.object({
  name: z.string(),
  /** A human phrase - "string", "string[]", "number | null" - not a JSON Schema type. */
  type: z.string(),
  required: z.boolean(),
  description: z.string().nullable(),
});
export type McpToolParameterDto = z.infer<typeof toolParameterSchema>;

/**
 * Everything about one tool that the list deliberately leaves out: the whole
 * description, and what the tool takes. Fetched per row on expand, so the
 * catalog response stays small however many tools are in it.
 */
export const toolDetailsSchema = z.object({
  registeredName: z.string(),
  description: z.string(),
  parameters: z.array(toolParameterSchema),
  /**
   * The raw input schema, pretty-printed. The parameter list is the readable
   * answer; this is the exact one, for a schema whose shape the flattening
   * cannot express.
   */
  inputSchema: z.string(),
});
export type McpToolDetailsDto = z.infer<typeof toolDetailsSchema>;

/**
 * A new server. The id is derived from `displayName` server-side rather than
 * typed by the user, so the two can never disagree.
 */
export const serverAddSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    kind: serverKindSchema,
    url: z.url().optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().trim().min(1).optional(),
    headers: headersSchema.optional(),
    // Optional so an http server needing a manually created client can be
    // configured in one step instead of added and then edited.
    oauthClientId: z.string().optional(),
    oauthClientSecret: z.string().optional(),
    oauthScopes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "local" && value.command === undefined) {
      ctx.addIssue({
        code: "custom", path: ["command"],
        message: "a local server needs a command to run",
      });
    }
    if (value.kind !== "local" && value.url === undefined) {
      ctx.addIssue({
        code: "custom", path: ["url"],
        message: "a remote server needs a url",
      });
    }
    if (value.kind === "local" && value.headers !== undefined) {
      ctx.addIssue({
        code: "custom", path: ["headers"],
        message: "a local server sends no requests; pass its configuration in env",
      });
    }
  });
export type McpServerAddInput = z.input<typeof serverAddSchema>;

/**
 * A project the panel can bind tools to. `personal` is called out because
 * every personal thread shares one project (design section 8), so that row is
 * the one most users actually want and it has to be recognisable in the list.
 */
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  personal: z.boolean(),
});
export type McpProjectDto = z.infer<typeof projectSchema>;

const okSchema = z.object({ ok: z.boolean() });

export const rpcContract = defineRpcContract({
  servers_list: {
    input: z.null(),
    output: z.object({ servers: z.array(serverSchema) }),
  },
  servers_add: {
    input: serverAddSchema,
    output: z.object({ server: serverSchema }),
  },
  /**
   * Save the OAuth client the user created for one server.
   *
   * A `null` field leaves the stored value alone, which is the only way an
   * edit can preserve a secret the panel was never told. Saving destroys the
   * server's existing grant: a token issued to a different client id, or for
   * different scopes, is not a token this configuration can go on using.
   */
  servers_set_oauth_client: {
    input: z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      clientSecret: z.string().nullable(),
      scopes: z.string().nullable(),
    }),
    output: okSchema,
  },
  /**
   * Replace a remote server's extra request headers, wholesale.
   *
   * Wholesale rather than field by field because the panel edits the whole set
   * as text: a merge would give no way to delete a header, and a header the
   * user deleted is exactly the one that must stop being sent. Saving drops
   * the pooled client - Streamable HTTP bakes its headers in at construction,
   * so a live connection would go on sending the old set.
   */
  servers_set_headers: {
    input: z.object({ id: z.string(), headers: headersSchema }),
    output: okSchema,
  },
  servers_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  /**
   * Start the OAuth dance for a remote server and hand back the URL to send
   * the user's browser to. Never opens anything itself: the panel owns
   * navigation, and the backend has no browser.
   */
  servers_connect: {
    input: z.object({
      id: z.string(),
      /**
       * The origin the panel is being served from, so the callback comes back
       * to a host this user can actually reach. Sent by the client rather than
       * derived on the server: `bb.server.loopbackBaseUrl` is always
       * `127.0.0.1`, which is nowhere at all for a browser on a tailnet or a
       * BB Connect tunnel.
       */
      redirectOrigin: z.url(),
    }),
    /**
     * `authorizeUrl` is `null` when the server answered without credentials:
     * there is no sign-in to start, and its tools were already read.
     */
    output: z.object({ authorizeUrl: z.string().nullable() }),
  },
  /**
   * Exchange an authorization code the panel caught on its own callback route.
   *
   * The counterpart to landing the redirect in the app instead of on the
   * plugin's public HTTP route. `state` is still the single-use nonce the flow
   * parked, so this adds no trust: it only moves the exchange behind the same
   * authentication every other call in this contract already has.
   */
  oauth_complete: {
    input: z.object({ code: z.string(), state: z.string() }),
    output: z.object({ serverId: z.string(), displayName: z.string() }),
  },
  /**
   * Reload this plugin.
   *
   * The only way to put a changed tool description in front of a model:
   * `registerTool` has no update, so a description that moved after
   * registration - adding an integration to a gateway rewrites its tool's
   * description - reaches nobody until every registration is rebuilt.
   */
  plugin_reload: {
    input: z.null(),
    output: okSchema,
  },
  /**
   * Connect to one server and report what happened, including the child's
   * stderr tail.
   *
   * The reason this plugin exists in the shape it does: the BB server resolves
   * no login-shell PATH, so an `npx`- or `docker`-based stdio server dies with
   * an opaque `CONNECTION_CLOSED` in every other client. The tail is the only
   * place the actual reason ("command not found", a missing module, a bad
   * token) is ever visible.
   */
  servers_test: {
    input: z.object({ id: z.string() }),
    output: z.object({
      ok: z.boolean(),
      toolCount: z.number(),
      error: z.string().nullable(),
      stderr: z.array(z.string()),
    }),
  },
  /** Fetch tools/list for one server and persist the diff. */
  catalog_sync: {
    input: z.object({ serverId: z.string() }),
    output: z.object({ added: z.array(z.string()), total: z.number() }),
  },
  tools_list: {
    input: z.object({ serverId: z.string().optional() }),
    output: z.object({ tools: z.array(toolSchema) }),
  },
  /**
   * The full description and parameters of one tool, on demand.
   *
   * Its own call rather than fields on `tools_list`: a schema per tool would
   * make the catalog response hundreds of kilobytes to render a column that
   * is collapsed for every row but the one the user opened.
   */
  tool_details: {
    input: z.object({ registeredName: z.string() }),
    output: z.object({ tool: toolDetailsSchema }),
  },
  tool_set_ask: {
    input: z.object({
      serverId: z.string(), upstreamName: z.string(), ask: z.boolean(),
    }),
    output: okSchema,
  },
  /**
   * One project's overrides, on ones and off ones alike.
   *
   * A flat list of enabled names cannot tell "this project switched the tool
   * off" from "this project never said anything", and with defaults in play
   * those two render differently and resolve differently.
   */
  bindings_list: {
    input: z.object({ projectId: z.string() }),
    output: z.object({
      overrides: z.array(z.object({
        registeredName: z.string(), enabled: z.boolean(),
      })),
    }),
  },
  /** `inherit` drops the override; the other two pin the tool for this project. */
  binding_set: {
    input: z.object({
      projectId: z.string(),
      registeredName: z.string(),
      state: z.enum(["inherit", "on", "off"]),
    }),
    output: okSchema,
  },
  /**
   * Make tools available in every project that has not overridden them off.
   *
   * Batched because the panel offers a whole-server toggle, and 500 is well
   * past any real catalog while still bounding the payload.
   */
  tools_set_default: {
    input: z.object({
      registeredNames: z.array(z.string()).min(1).max(500),
      defaultEnabled: z.boolean(),
    }),
    output: z.object({ updated: z.number() }),
  },
  /**
   * The projects a binding can name. `includePersonal` is not the default, and
   * leaving it off would hide the single project every personal thread runs
   * in - the one place an MCP server is most wanted.
   */
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema) }),
  },
});
export type McpRpcContract = typeof rpcContract;

/**
 * The renderer the consent prompt is drawn with.
 *
 * BB puts every plugin tool into Claude Code's `allowedTools` and Codex
 * forwards tool calls with no approval hook, so no provider asks on this
 * plugin's behalf: this prompt is the ONLY thing between a model and a write
 * to the user's Gmail or Slack (design section 9).
 */
export const CONSENT_RENDERER_ID = "mcp-consent";

/**
 * What the prompt shows. `summary` is a truncated `JSON.stringify` of the
 * arguments rather than the arguments themselves: `requestInput` rejects a
 * payload over 64 KiB outright, and a rejected payload denies a call the user
 * never got to see.
 */
export const consentPayloadSchema = z.object({
  serverName: z.string(),
  toolName: z.string(),
  summary: z.string(),
  destructive: z.boolean(),
});
export type McpConsentPayload = z.infer<typeof consentPayloadSchema>;

/**
 * What the user answered. "thread" is remembered for this tool in this thread
 * until the thread ends; "once" covers only the call that asked.
 */
export const consentResponseSchema = z.object({
  decision: z.enum(["once", "thread", "deny"]),
});
export type McpConsentResponse = z.infer<typeof consentResponseSchema>;
