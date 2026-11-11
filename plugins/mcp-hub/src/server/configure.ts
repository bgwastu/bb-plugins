import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CatalogTool, Registry } from "../storage/registry.js";
import { integrationSearchTerms } from "./gateway.js";
import { warnQuietly } from "./log.js";

/**
 * The host rejects a plugin's whole selection above this many ids, so the
 * selection is capped here instead: losing the tools past the cap beats
 * losing all of them.
 */
export const MAX_SELECTED_TOOLS = 256;

/** The host truncates dynamic instructions past this, so they are built to fit. */
export const MAX_INSTRUCTIONS = 4096;

/**
 * What every project gets, and how individual projects differ from it.
 *
 * Stored as defaults plus overrides rather than a project-to-names map
 * because a default-on tool has to reach projects this plugin has never heard
 * of - including one created a second ago. Enumerating projects to build that
 * map is impossible; enumerating the projects that DISAGREE with the default
 * is a read of the bindings table.
 */
export interface Selection {
  defaults: ReadonlySet<string>;
  overrides: ReadonlyMap<string, { on: ReadonlySet<string>; off: ReadonlySet<string> }>;
  /**
   * What an agent is told about the gateways in this selection, prebuilt.
   *
   * Prebuilt because `bb.agents.configure` is synchronous and runs on the
   * thread-start path: reading the catalog there would put a database query
   * in front of every turn. Empty when no gateway is configured, which is the
   * right answer - an ordinary MCP server needs no explaining.
   */
  instructions: string;
}

/**
 * What to tell an agent about the gateway servers it has tools from.
 *
 * A gateway contributes a handful of tools that reach a much larger set the
 * catalog never sees, and the services behind it are named only inside one
 * tool's description - which a provider may never show the model. Claude Code
 * lists a plugin tool by name and loads its description only on a keyword
 * search, and that search matches whole words, so an agent asked about Notion
 * searches, finds nothing, and reports that nothing offers Notion while the
 * tool that reaches it sits in its own tool list.
 *
 * This is the fix that does not depend on the user having written anything:
 * the integrations are stated up front, as words, with the exact-name load
 * that retrieves the real description.
 */
export function buildInstructions(rows: readonly CatalogTool[]): string {
  const gateways = new Map<string, { tools: string[]; reaches: Set<string> }>();
  for (const row of rows) {
    if (row.stale) continue;
    const terms = integrationSearchTerms(row.description);
    if (terms.length === 0) continue;
    let entry = gateways.get(row.serverId);
    if (entry === undefined) {
      entry = { tools: [], reaches: new Set() };
      gateways.set(row.serverId, entry);
    }
    entry.tools.push(row.registeredName);
    for (const term of terms) entry.reaches.add(term);
  }
  if (gateways.size === 0) return "";

  const lines = [
    "Some of your tools are gateways: one tool reaches many services that are "
    + "not in your tool list under their own names. Before saying a service is "
    + "unavailable, check this list.",
    "",
  ];
  for (const [serverId, entry] of gateways) {
    lines.push(
      `- ${entry.tools.sort().join(", ")} (MCP server "${serverId}") reach: `
      + `${[...entry.reaches].sort().join(", ")}.`,
    );
  }
  lines.push(
    "",
    "Your provider may list these tools by name only and load the description "
    + "when you search for it, and that search matches whole words - a query for "
    + "\"notion\" need not reach a tool called `execute`. So load a gateway tool "
    + "by its exact name rather than by keyword (in Claude Code, `ToolSearch` "
    + "with `select:<name>`, where the name may carry your provider's prefix for "
    + "BB tools, e.g. `select:mcp__bb-bridge__execute`), or run `bb mcp-hub list` in "
    + "a shell, which involves no search at all.",
  );
  const text = lines.join("\n");
  return text.length <= MAX_INSTRUCTIONS ? text : `${text.slice(0, MAX_INSTRUCTIONS - 1)}\u2026`;
}

/**
 * The tool selection, as one immutable snapshot.
 *
 * `bb.agents.configure` runs synchronously on the thread-start path while a
 * background sync may be writing the catalog, so nothing is ever mutated in
 * place: a refresh builds a whole new snapshot and swaps it in with a single
 * assignment. A reader either sees the old one or the new one, never a
 * half-updated one.
 */
export interface SelectionStore {
  snapshot(): Selection;
  /** Rebuild the snapshot from the registry. */
  refresh(): void;
}

const EMPTY: Selection = { defaults: new Set(), overrides: new Map(), instructions: "" };

/** `defaults - forcedOff + forcedOn`, in a deterministic order. */
export function resolveSelection(selection: Selection, projectId: string): string[] {
  const override = selection.overrides.get(projectId);
  if (override === undefined) return [...selection.defaults].sort();
  const names = new Set(selection.defaults);
  for (const name of override.off) names.delete(name);
  for (const name of override.on) names.add(name);
  // Sorted, because the cap below truncates: an unstable order would offer
  // the model a different 256 tools on every resolution.
  return [...names].sort();
}

export function createSelectionStore(deps: {
  registry: Registry;
  /**
   * Names the host accepted, each mapped to the server it was registered for.
   *
   * The owner matters as much as the name: a registration outlives the catalog
   * row it was built from, so a name whose row now belongs to a different
   * server would show the model one server's schema over another's tool.
   */
  registeredOwners(): ReadonlyMap<string, string>;
  log: { warn(message: string): void };
}): SelectionStore {
  let current: Selection = EMPTY;

  function build(): Selection {
    // A name the host does not know rejects this plugin's entire selection
    // for that resolution, so only names that are both registered and still
    // fresh in the catalog are eligible. A binding left behind by a removed
    // or renamed tool therefore costs nothing.
    const registered = deps.registeredOwners();
    // A disabled server's flag was inert while a tool needed a per-project
    // tick to be seen at all. It stops being inert the moment a default
    // spreads that tool to every project at once.
    const disabledServers = new Set(
      deps.registry.listServers().filter((server) => !server.enabled).map((server) => server.id),
    );
    const rows = deps.registry
      .listTools()
      .filter((row) => !row.stale
        && registered.get(row.registeredName) === row.serverId
        && !disabledServers.has(row.serverId));
    const selectable = new Set(rows.map((row) => row.registeredName));
    const defaults = new Set(
      rows.filter((row) => row.defaultEnabled).map((row) => row.registeredName),
    );

    const overrides = new Map<string, { on: Set<string>; off: Set<string> }>();
    for (const binding of deps.registry.listBindingStates()) {
      // An off row needs no `selectable` filter: it only ever removes a name,
      // and removing one that was never offered is free.
      if (binding.enabled && !selectable.has(binding.registeredName)) continue;
      let entry = overrides.get(binding.projectId);
      if (entry === undefined) {
        entry = { on: new Set(), off: new Set() };
        overrides.set(binding.projectId, entry);
      }
      (binding.enabled ? entry.on : entry.off).add(binding.registeredName);
    }
    return { defaults, overrides, instructions: buildInstructions(rows) };
  }

  function refresh(): void {
    try {
      current = build();
    } catch (error) {
      // Keeping the previous snapshot is the safe failure: threads keep the
      // tools they had rather than silently losing all of them.
      deps.log.warn(`Could not rebuild the MCP tool selection: ${String(error)}`);
    }
  }

  return {
    snapshot: () => current,
    refresh,
  };
}

/**
 * Answers `bb.agents.configure` from the selection snapshot.
 *
 * The callback is synchronous, runs on every thread start and turn submit,
 * and a throw fails this plugin's whole contribution closed - so it does the
 * least possible work: one map lookup and a set difference.
 */
export function registerConfigure(
  bb: BbPluginApi,
  deps: { selection: () => Selection },
): void {
  bb.agents.configure((context) => {
    let tools: string[];
    try {
      tools = resolveSelection(deps.selection(), context.project.id);
    } catch (error) {
      warnQuietly(bb, `MCP tool selection failed for project "${context.project.id}": ${String(error)}`);
      return { tools: [], skills: [] };
    }
    // Read once and reused: the snapshot may be swapped between these two
    // statements, and instructions describing a different set of tools than
    // the ones offered would be worse than none.
    const { instructions } = deps.selection();
    const extra = instructions === "" ? {} : { instructions };
    if (tools.length > MAX_SELECTED_TOOLS) {
      warnQuietly(
        bb,
        `Project "${context.project.id}" has ${tools.length} MCP tools bound; `
        + `only the first ${MAX_SELECTED_TOOLS} are offered to the model.`,
      );
      return { tools: tools.slice(0, MAX_SELECTED_TOOLS), skills: [], ...extra };
    }
    return { tools, skills: [], ...extra };
  });
}
