import type {
  BbPluginApi,
  PluginAgentToolContentPart,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import type { ClientPool } from "../mcp/client-pool.js";
import { isUnauthorized } from "../oauth/flow.js";
import type { CatalogTool, Registry } from "../storage/registry.js";
import { integrationSearchTerms } from "./gateway.js";
import { warnQuietly } from "./log.js";

/** How long one upstream tool call may run before the pool aborts it. */
export const CALL_TIMEOUT_MS = 90_000;

/** BB caps a timeline row label at this many characters and rejects the
 * whole registration when one is longer. */
const LABEL_MAX_CHARS = 80;

/**
 * `<prefix><tool name>`, shortened to fit BB's label budget.
 *
 * Upstream MCP tool names have no length limit, and an over-long label does
 * not degrade the row - it makes `registerTool` throw, which would lose the
 * tool entirely. The budget BB measures is UTF-16 code units, but truncation
 * advances one code point at a time so it can never leave a lone surrogate
 * behind.
 */
export function statusLabel(prefix: string, upstreamName: string): string {
  const budget = LABEL_MAX_CHARS - prefix.length;
  if (upstreamName.length <= budget) return `${prefix}${upstreamName}`;
  const ellipsis = "...";
  let kept = "";
  for (const codePoint of upstreamName) {
    if (kept.length + codePoint.length > budget - ellipsis.length) break;
    kept += codePoint;
  }
  return `${prefix}${kept}${ellipsis}`;
}

/**
 * Runs one catalog tool. Injected so tests and the HTTP endpoint can supply
 * their own upstream call.
 */
export type ToolExecutor = (
  tool: CatalogTool,
  args: Record<string, unknown>,
  ctx: PluginAgentToolContext,
) => Promise<PluginAgentToolResult>;

/**
 * What this plugin load has tried to register, and what the host took.
 *
 * `bb.agents.registerTool` rejects a second registration of the same name
 * within one plugin and the SDK exposes no way to list what is registered, so
 * the plugin has to remember. Keying that memory on the `bb` handle ties its
 * lifetime to exactly one plugin load: a reload gets a fresh handle and
 * therefore fresh sets, and the entries are collectable once the handle is
 * gone.
 *
 * Two maps, because they answer different questions. `attemptedOwners` stops a
 * later sync from re-attempting a name, whether it worked or not.
 * `acceptedOwners` is the only thing allowed to feed the per-project selection:
 * a name the host refused must never reach `bb.agents.configure`, because an
 * unknown name there rejects this plugin's COMPLETE selection and takes every
 * other MCP tool down with it.
 *
 * Both record WHICH SERVER a name was registered for, not just the name. The
 * two lifetimes differ: these live for the whole plugin load, the catalog rows
 * they describe do not. Remove a server and add another inside one load and
 * `resolveName` hands out the same bare name again - so a name registered with
 * Notion's description and schema could be left dispatching to Linear, because
 * `execute` re-reads the row by name alone. Recording the owner is what lets
 * the registration check that the row it just read is still its own, and what
 * lets the selection drop a name whose owner has changed.
 *
 * What neither set can tell you is whether another plugin already owns a name.
 * `registerTool` reports a cross-plugin collision as a status detail and
 * returns silently - it neither throws nor returns a value - so a collided
 * name is indistinguishable from an accepted one and lands in `acceptedNames`
 * anyway, and from there into the per-project selection, where it rejects
 * this plugin's complete selection exactly as a refused name would.
 *
 * There is no detection at this layer and no workaround: the SDK exposes no
 * way to list the host's registered tools, and the obvious signal - a later
 * "unknown tool" at execute time - can never fire, because a collided tool is
 * never offered to the model and so is never called. The exposure is real
 * rather than theoretical: names are registered unprefixed unless they
 * collide inside this plugin (design section 5), so a common upstream name is
 * exactly the kind another plugin may already own.
 */
const attemptedOwners = new WeakMap<BbPluginApi, Map<string, string>>();
const acceptedOwners = new WeakMap<BbPluginApi, Map<string, string>>();
/**
 * name -> the shape the host was actually handed, for names it accepted.
 *
 * Same lifetime as the two above and for the same reason: it describes a live
 * registration, and a reload replaces every registration this plugin owns.
 */
const registeredShapes = new WeakMap<BbPluginApi, Map<string, string>>();

function mapFor(
  store: WeakMap<BbPluginApi, Map<string, string>>,
  bb: BbPluginApi,
): Map<string, string> {
  let entries = store.get(bb);
  if (!entries) {
    entries = new Map<string, string>();
    store.set(bb, entries);
  }
  return entries;
}

/**
 * The part of a row a registration freezes.
 *
 * `readOnly`, staleness and the owner are all re-read inside `execute`
 * on every call, so they follow the catalog on their own. The description and
 * the input schema have no such path: they are copied into `registerTool` once
 * and there is no way to put new ones in front of the model afterwards.
 */
function registeredShape(row: CatalogTool): string {
  return JSON.stringify([row.description, row.inputSchema]);
}

/**
 * The description the host is handed for a row.
 *
 * Two things the server's own text may not carry. A server that gave no
 * description at all gets one, because a nameless tool in a list is worse
 * than a dull sentence. And a gateway tool that names the services it
 * reaches as slugs gets those slugs again as words, because that is the only
 * form a provider's tool search can match - see `gateway.ts` for what goes
 * wrong without it.
 *
 * Pure in the row, which is what keeps {@link driftedToolNames} honest: it
 * compares catalog rows, not the text built from them.
 */
export function registrationDescription(row: CatalogTool): string {
  const described = row.description.trim() === ""
    ? `The "${row.upstreamName}" tool from MCP server "${row.serverId}".`
    : row.description;
  const terms = integrationSearchTerms(described);
  if (terms.length === 0) return described;
  return `${described}\n\nReaches: ${terms.join(", ")}.`;
}

/**
 * Registered names whose catalog row has moved since the host took it.
 *
 * A sync only ever ADDS names, so a server that rewrites an existing tool's
 * description or schema lands in the catalog and goes no further - the model
 * keeps being shown whatever was registered when the name was claimed, and
 * `catalog_sync` cannot help because `registerCatalogTools` skips the name.
 * Only a reload re-registers it.
 *
 * This cannot repair the drift and deliberately does not try; auto-reloading
 * would cancel every pending interaction on every thread. It exists so the
 * panel and `bb mcp-hub list` can say a reload is owed instead of leaving the
 * user to wonder why a sync changed nothing.
 */
export function driftedToolNames(
  bb: BbPluginApi,
  rows: readonly CatalogTool[],
): ReadonlySet<string> {
  const shapes = registeredShapes.get(bb);
  const drifted = new Set<string>();
  if (!shapes) return drifted;
  for (const row of rows) {
    const registered = shapes.get(row.registeredName);
    if (registered !== undefined && registered !== registeredShape(row)) {
      drifted.add(row.registeredName);
    }
  }
  return drifted;
}

/**
 * The names the host accepted, each mapped to the server it was registered
 * for - safe to hand to `bb.agents.configure` only while the catalog still
 * agrees about the owner.
 */
export function registeredToolOwners(bb: BbPluginApi): ReadonlyMap<string, string> {
  return acceptedOwners.get(bb) ?? new Map<string, string>();
}

function errorResult(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function asArguments(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

/**
 * Registers every fresh catalog row that is not registered yet.
 *
 * Safe to call again after a sync, and that is the point: `registerTool`
 * works after load (`plugin-api.ts` handles post-load registration), so a
 * background refresh registers newly discovered tools live and they reach a
 * thread when its provider session is next constructed. The alternative -
 * asking the user to reload - cancels every pending interaction on every
 * thread and drains in-flight calls after five seconds.
 */
export function registerCatalogTools(
  bb: BbPluginApi,
  deps: { registry: Registry; execute: ToolExecutor },
): void {
  const attempted = mapFor(attemptedOwners, bb);
  const accepted = mapFor(acceptedOwners, bb);
  const shapes = mapFor(registeredShapes, bb);

  for (const row of deps.registry.listTools()) {
    // A stale row keeps its name reserved but is not worth advertising to a
    // model; if it comes back on a later sync it is registered then.
    if (row.stale) continue;
    const priorOwner = attempted.get(row.registeredName);
    if (priorOwner !== undefined) {
      if (priorOwner !== row.serverId) {
        // A name this load already registered for a DIFFERENT server. There is
        // no unregisterTool, so the live registration still carries the other
        // server's description and schema; re-registering would throw and
        // registering nothing is the only honest answer. The selection drops
        // it too, so the model is never offered a tool whose schema belongs to
        // one server and whose call would reach another.
        warnQuietly(
          bb,
          `MCP tool name "${row.registeredName}" is already registered in this session `
          + `for server "${priorOwner}", so server "${row.serverId}" cannot use it. `
          + "Reload the MCP plugin to hand the name over.",
        );
      }
      continue;
    }

    const registeredName = row.registeredName;
    const ownerId = row.serverId;
    // Recorded before the attempt: a registration this host refuses (a
    // recursive schema, a reserved name) is refused the same way every time,
    // and retrying it on every background sync would only repeat the log
    // line. It is deliberately NOT recorded as accepted here - only a
    // registerTool call that returned does that.
    attempted.set(registeredName, ownerId);
    try {
      bb.agents.registerTool({
        name: registeredName,
        description: registrationDescription(row),
        parameters: row.inputSchema,
        presentation: {
          label: {
            pending: statusLabel("Running ", row.upstreamName),
            completed: statusLabel("Ran ", row.upstreamName),
          },
        },
        async execute(params: unknown, ctx: PluginAgentToolContext) {
          // Re-read the row instead of closing over it: the schema and
          // staleness all change under a live registration, and there is no
          // way to re-register a name to pick the new values up.
          const current = deps.registry.getToolByRegisteredName(registeredName);
          if (!current) {
            return errorResult(
              `The MCP tool "${registeredName}" is gone: server "${row.serverId}" is no longer configured. `
              + "Ask the user to re-add it in the MCP panel.",
            );
          }
          if (current.stale) {
            return errorResult(
              `The MCP tool "${registeredName}" is no longer offered by server "${current.serverId}". `
              + "Ask the user to re-sync that server in the MCP panel.",
            );
          }
          // The row under this name belongs to a different server than the one
          // whose description and schema the model was shown. Running it would
          // send those arguments somewhere the model never chose.
          if (current.serverId !== ownerId) {
            return errorResult(
              `The MCP tool "${registeredName}" now belongs to server "${current.serverId}", `
              + `not "${ownerId}" whose description and schema this registration carries. `
              + "It was not run. Ask the user to reload the MCP plugin.",
            );
          }
          return deps.execute(current, asArguments(params), ctx);
        },
      });
      accepted.set(registeredName, ownerId);
      // Recorded from the row that was just handed over, not re-read later: a
      // shape taken after the fact would match by construction and could never
      // report drift.
      shapes.set(registeredName, registeredShape(row));
    } catch (error) {
      warnQuietly(
        bb,
        `Could not register MCP tool "${registeredName}" from server "${row.serverId}": ${String(error)}`,
      );
    }
  }
}

/**
 * The production {@link ToolExecutor}: one upstream MCP call, translated into
 * a BB tool result.
 *
 * Every failure comes back as an `isError` result rather than a throw, so an
 * unreachable server or a dead stdio child never fails the turn (design
 * section 10) and the model is told what a human would have to fix.
 */
export function createMcpExecutor(deps: {
  registry: Registry;
  pool: ClientPool;
  stderrTail(serverId: string): string[];
  timeoutMs?: number;
  /**
   * Forces an OAuth refresh and reports whether a new token came back. Absent
   * for a plugin build with no remote servers configured, in which case a 401
   * is simply an error.
   */
  refreshAuth?(serverId: string): Promise<boolean>;
  /**
   * Records why this server's credentials stopped working, so the panel and
   * `bb mcp-hub list` say the same thing this error does. A 401 that survives a
   * refresh is the other way a grant is discovered to be dead, besides the
   * refresh itself being refused.
   */
  reportAuthFailure?(serverId: string, message: string): void;
}): ToolExecutor {
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;

  /**
   * What the panel already knows about this server's credentials, appended to
   * an error so an agent can tell the user the actual cause rather than
   * "reconnect it and hope".
   */
  const storedReason = (serverId: string): string => {
    const message = deps.registry.getServer(serverId)?.authError;
    return message === null || message === undefined ? "" : ` ${message}`;
  };
  return async (tool, args, ctx) => {
    const server = deps.registry.getServer(tool.serverId);
    if (!server) {
      return errorResult(
        `MCP server "${tool.serverId}" is no longer configured, so "${tool.upstreamName}" cannot run.`,
      );
    }
    const call = (): Promise<{ content: PluginAgentToolContentPart[]; isError: boolean }> =>
      deps.pool.callTool(server, tool.upstreamName, args, { signal: ctx.signal, timeoutMs });
    try {
      const result = await call();
      return { content: result.content, isError: result.isError };
    } catch (error) {
      // A 401 is the server being authoritative about a token this plugin
      // still believed in, so it is worth one refresh and one retry - but
      // ONLY for a read. The upstream call may well have succeeded and failed
      // on the way back, and replaying a write means a second message sent, a
      // second row created, a second payment made. A failed write the user
      // repeats deliberately is strictly better than a silent duplicate.
      if (isUnauthorized(error) && tool.readOnly && deps.refreshAuth) {
        try {
          if (await deps.refreshAuth(server.id)) {
            // The pool dropped its cached client when the call failed, so
            // this reconnects and picks up the new bearer token.
            const retried = await call();
            return { content: retried.content, isError: retried.isError };
          }
        } catch (retryError) {
          return errorResult(
            `MCP server "${server.displayName}" rejected the stored credentials for `
            + `"${tool.upstreamName}" and the retry failed: ${String(retryError)}`,
          );
        }
        deps.reportAuthFailure?.(
          server.id,
          "The server rejected the stored credentials and refreshing them did not "
          + "help, so this connection has to be authorized again.",
        );
        return errorResult(
          `MCP server "${server.displayName}" rejected the stored credentials for `
          + `"${tool.upstreamName}". Ask the user to reconnect it in the MCP panel.`
          + storedReason(server.id),
        );
      }
      // A write that hit a 401 falls through the branch above by design. It
      // still deserves better than the generic transport error: the user
      // needs to know it was not retried on purpose and that retrying is the
      // right move, because the failure already dropped the cached client.
      if (isUnauthorized(error) && !tool.readOnly) {
        return errorResult(
          `MCP server "${server.displayName}" rejected the stored credentials for `
          + `"${tool.upstreamName}". This tool can change data, so it was not retried `
          + "automatically - replaying it could duplicate the change. The cached "
          + "connection was dropped; try again, and if that also fails ask the user "
          + "to reconnect the server in the MCP panel."
          + storedReason(server.id),
        );
      }
      // A local server's own stderr is the diagnostic the user needs (a
      // missing npx package, a bad path) and it is nowhere else in BB.
      const tail = server.transport === "stdio" ? deps.stderrTail(server.id) : [];
      const details = tail.length > 0
        ? `\nLast output from the server:\n${tail.slice(-20).join("\n")}`
        : "";
      return errorResult(
        `MCP server "${server.displayName}" could not run "${tool.upstreamName}": ${String(error)}${details}`,
      );
    }
  };
}
