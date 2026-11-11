import type { ClientPool } from "./mcp/client-pool.js";
import { resolveName } from "./mcp/naming.js";
import type { CatalogTool, Registry, ServerRecord } from "./storage/registry.js";

/**
 * The cached view of what each MCP server offers.
 *
 * Everything downstream - tool registration, per-project selection, the panel
 * - reads the catalog, never the network. `sync` is the only thing that talks
 * to a server, and it runs from an explicit RPC or the background refresh, so
 * the plugin load path can never block on an unreachable server.
 */
/**
 * Hosts whose tools always prompt, whatever `readOnlyHint` says.
 *
 * Design section 12.1 names prompt injection as the plugin's first risk and
 * Gmail as its worst case: reading an attacker-authored mail IS the attack, so
 * a read annotation buys a Google Workspace tool nothing. The host is the only
 * handle there is: nothing in an MCP catalog says whose mail this is.
 */
const ALWAYS_ASK_HOSTS = ["googleapis.com", "google.com"] as const;

/**
 * Whether every tool from `server` must prompt regardless of its annotation
 * and regardless of what the user clicked.
 *
 * Deliberately not overridable: a user who switches the prompt off for a
 * Gmail tool has disarmed the mitigation for the risk it exists to cover, and
 * the panel says so rather than offering the switch.
 */
export function alwaysAsks(server: Pick<ServerRecord, "transport" | "url">): boolean {
  if (server.transport !== "http" || server.url === null) return false;
  try {
    const host = new URL(server.url).hostname.toLowerCase();
    return ALWAYS_ASK_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  } catch {
    return false;
  }
}

export interface Catalog {
  /** Fetch tools/list for one server and persist the diff. Returns added names. */
  sync(serverId: string): Promise<string[]>;
  syncAll(): Promise<void>;
}

/**
 * What `ask` should be for one tool on this sync.
 *
 * The rule the old one-liner got wrong: `read_only` is rewritten on every
 * sync, so a DERIVED `ask` has to be rewritten with it. A tool that was
 * advertised as read-only and now is not has to start asking again, or a
 * server that flips the annotation after the user bound the tool disarms the
 * consent gate silently and permanently. Only a choice the user made by hand
 * outranks the annotation - and nothing outranks a forced-ask host.
 */
function resolveAsk(
  prior: CatalogTool | undefined,
  readOnly: boolean,
  forceAsk: boolean,
): boolean {
  if (forceAsk) return true;
  if (prior?.askOverridden) return prior.ask;
  if (prior && prior.readOnly === readOnly) return prior.ask;
  return !readOnly;
}

/**
 * How long a server whose grant is dead is left alone between attempts.
 *
 * A `needs-reconnect` server answers 401 to everything until a human presses
 * Reconnect, and the background sweep runs every seventeen minutes: retrying
 * it on every cycle is how four days of byte-identical failures ended up in a
 * log file. Hourly still notices promptly if the grant comes back some other
 * way, and costs 1/3.5 of the noise.
 */
const RECONNECT_RETRY_MS = 60 * 60 * 1000;

export function createCatalog(deps: {
  registry: Registry;
  pool: ClientPool;
  log: { warn(message: string): void; info(message: string): void };
  /** Whether this server's credentials are known to be dead. */
  needsReconnect?(serverId: string): boolean;
}): Catalog {
  // In memory, not persisted: it only has to survive between cron cycles of
  // one load, and a reload is a good moment to try again anyway.
  const lastBlockedAttempt = new Map<string, number>();
  async function sync(serverId: string): Promise<string[]> {
    const server = deps.registry.getServer(serverId);
    if (!server) {
      throw new Error(`No MCP server with id "${serverId}"`);
    }

    let discovered;
    try {
      discovered = await deps.pool.listTools(server);
    } catch (error) {
      // Never clear a catalog on a failed tools/list (design section 10): the
      // rows stay exactly as they were so a server that is merely down keeps
      // its tools registered and its bindings intact. The throw is for the
      // caller that asked for this sync - `syncAll` swallows it per server so
      // one broken server cannot stop the refresh, while the panel's Sync
      // button gets a real error instead of a silent "0 tools".
      deps.log.warn(
        `MCP catalog sync for "${serverId}" failed, keeping the cached catalog: ${String(error)}`,
      );
      throw error;
    }

    const existing = deps.registry.listTools();
    // Every persisted name is taken, including this server's own and stale
    // rows: they all still occupy the unique index on registered_name, and a
    // stale row can come back to life on a later sync under the same name.
    const taken = new Set(existing.map((row) => row.registeredName));
    const priorByUpstream = new Map(
      existing
        .filter((row) => row.serverId === serverId)
        .map((row) => [row.upstreamName, row]),
    );

    const forceAsk = alwaysAsks(server);
    const syncedAt = Date.now();
    const rows: CatalogTool[] = [];
    const added: string[] = [];
    for (const tool of discovered) {
      // A name is resolved once and persisted forever: renaming a tool the
      // model already learned about mid-conversation is worse than an ugly
      // prefix.
      const prior = priorByUpstream.get(tool.name);
      let registeredName: string;
      if (prior) {
        registeredName = prior.registeredName;
      } else {
        registeredName = resolveName({
          serverId, upstreamName: tool.name, taken,
        }).registeredName;
        taken.add(registeredName);
        added.push(registeredName);
      }
      rows.push({
        serverId,
        upstreamName: tool.name,
        registeredName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly,
        ask: resolveAsk(prior, tool.readOnly, forceAsk),
        // A forced-ask server has no user decision to preserve: the flag is
        // kept off so the row never claims a choice the user cannot make.
        askOverridden: forceAsk ? false : prior?.askOverridden ?? false,
        // Carried forward like the name: the default is the user's answer to
        // "everywhere or nowhere", and a server that answers tools/list has
        // no say in it. A sync that dropped it would switch the tool off in
        // every project at once.
        defaultEnabled: prior?.defaultEnabled ?? false,
        stale: false,
        syncedAt,
      });
    }

    deps.registry.replaceCatalog(serverId, rows);
    if (added.length > 0) {
      deps.log.info(`MCP server "${serverId}" added ${added.length} tool(s): ${added.join(", ")}`);
    }
    return added;
  }

  return {
    sync,
    async syncAll(): Promise<void> {
      for (const server of deps.registry.listServers()) {
        if (!server.enabled) continue;
        // An explicit `sync` from the panel is never blocked - the user may
        // have just fixed the thing - but the sweep backs off.
        if (deps.needsReconnect?.(server.id) === true) {
          const last = lastBlockedAttempt.get(server.id) ?? 0;
          if (Date.now() - last < RECONNECT_RETRY_MS) continue;
          lastBlockedAttempt.set(server.id, Date.now());
        } else {
          lastBlockedAttempt.delete(server.id);
        }
        try {
          await sync(server.id);
        } catch {
          // Already logged in `sync`. One unreachable server must not stop
          // the refresh for every other server.
        }
      }
    },
  };
}
