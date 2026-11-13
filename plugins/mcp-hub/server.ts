// bb-plugin-mcp-hub - the BB plugin backend entry.
//
// Wiring only. It opens the database and the secrets file, builds the stack
// (store -> connections -> surfaces -> hub), registers every cached tool, and
// hands the same hub to RPC, the CLI and the background service.
//
// Nothing on this path talks to an MCP server. Tools are registered from the
// cache, so a server that is down, slow or waiting for a sign-in delays
// nothing; connecting is the background service's job and a tool call's job.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MCP_CHANGED } from "./contract.js";
import { createConnectionManager } from "./src/mcp/connection.js";
import { createStdioSupervisor, loginShellPath } from "./src/mcp/stdio.js";
import { normaliseSchema } from "./src/mcp/validate.js";
import { importLegacy } from "./src/storage/legacy.js";
import { MCP_MIGRATIONS } from "./src/storage/schema.js";
import { createSecretStore, secretsPathFor } from "./src/storage/secrets.js";
import { createStore } from "./src/storage/store.js";
import { registerCli } from "./src/server/cli.js";
import { createHub, createRestarter, type Hub, type Restarter } from "./src/server/hub.js";
import { quietLogger } from "./src/server/log.js";
import { registerProviderEnv } from "./src/server/provider-env.js";
import { registerRpc } from "./src/server/rpc.js";
import { resolveSelection, TOOL_LIMIT } from "./src/server/selection.js";
import { registerServices } from "./src/server/services.js";
import { createToolSurfaces } from "./src/server/tools.js";

const LEGACY_IMPORTED_KEY = "legacy-imported";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const database = bb.storage.database();
  bb.storage.migrate(database, MCP_MIGRATIONS);

  const store = createStore(database);
  const secrets = createSecretStore(secretsPathFor(database.name));
  const log = quietLogger(bb);

  // A one-time move from the 0.1 tables. The flag is what makes it one-time:
  // deleting every server later must not resurrect the old list.
  try {
    if ((await bb.storage.kv.get<boolean>(LEGACY_IMPORTED_KEY)) !== true) {
      const imported = importLegacy(database, secrets);
      if (imported.servers > 0) {
        log.info(
          `Imported ${imported.servers} MCP server(s), ${imported.tools} tool(s) and ${imported.tokens} sign-in(s) from the previous version.`,
        );
      }
      await bb.storage.kv.set(LEGACY_IMPORTED_KEY, true);
    }
  } catch (error) {
    log.warn(`Could not import the previous version's MCP servers: ${String(error)}`);
  }

  const stdio = createStdioSupervisor({ resolvePath: loginShellPath, log });

  // `onToolsChanged` fires from a notification handler long after this
  // factory returns, and the sync it starts must coalesce: a server that
  // changes its list twice in a second is one sync, not two.
  const pendingSyncs = new Map<string, NodeJS.Timeout>();
  let hub: Hub | null = null;

  function scheduleSync(serverId: string): void {
    const existing = pendingSyncs.get(serverId);
    if (existing) clearTimeout(existing);
    pendingSyncs.set(
      serverId,
      setTimeout(() => {
        pendingSyncs.delete(serverId);
        const server = store.getServer(serverId);
        if (!server || !hub) return;
        void hub.sync(server).catch((error: unknown) => {
          log.warn(`Could not refresh "${server.name}": ${String(error)}`);
        });
      }, 400),
    );
  }

  const connections = createConnectionManager({
    secrets,
    stdio,
    log,
    onToolsChanged: scheduleSync,
  });

  // Late-bound so the tool wrapper can call the hub, and the hub can ask the
  // surfaces what registered: both directions are real, and neither is worth
  // a third module.
  const surfaces = createToolSurfaces(bb, {
    store,
    execute: async (request) => {
      if (!hub) throw new Error("The MCP Hub plugin is still starting.");
      return hub.runTool({
        serverId: request.server.id,
        tool: request.tool.name,
        arguments: request.arguments,
        threadId: request.threadId,
      });
    },
    log,
  });

  const restarter: Restarter = createRestarter(bb);

  hub = createHub(bb, {
    store,
    secrets,
    connections,
    restarter,
    registered: () => surfaces.names(),
    registerTools: () => surfaces.register(),
    toolProblem: (name) => surfaces.problem(name),
    publish: () => {
      try {
        bb.realtime.publish(MCP_CHANGED, null);
        // A dead grant reaches `bb plugin list` and the BB UI through this,
        // without anyone opening the panel.
        reportStatus();
      } catch {
        // A publish after dispose; nothing is listening.
      }
    },
    log,
  });
  const readyHub = hub;

  // From the cache, before anything connects.
  const registeredNow = surfaces.register();
  if (registeredNow.length > 0) log.info(`Registered ${registeredNow.length} MCP tool(s).`);

  bb.agents.configure(() => {
    try {
      const selection = resolveSelection(store, surfaces.names());

      const notes: string[] = [];
      if (selection.truncated) {
        notes.push(
          `${selection.offered} MCP tools are available but a session carries at most ${TOOL_LIMIT}; `
            + `only ${TOOL_LIMIT} are offered here. Turn some off in the MCP button next to the message box.`,
        );
      }
      const broken = store
        .listServers()
        .filter((server) => server.enabled && connections.status(server.id).state === "needs-auth");
      if (broken.length > 0) {
        notes.push(
          `These MCP servers need a sign-in and their tools will fail until they are reconnected in the MCP settings: ${broken
            .map((server) => server.name)
            .join(", ")}.`,
        );
      }

      return {
        // The schema travels with the selection, so a tool whose server changed
        // its arguments after registration is advertised correctly to the next
        // session instead of waiting for a plugin reload.
        tools: selection.tools.map(({ tool }) => ({
          name: tool.name,
          parameters: normaliseSchema(tool.inputSchema),
        })),
        skills: ["mcp-hub"],
        ...(notes.length > 0 ? { instructions: notes.join("\n\n") } : {}),
      };
    } catch (error) {
      // A selection this plugin cannot compute must not take the thread's
      // whole plugin surface with it; an empty selection still starts.
      log.warn(`Could not resolve MCP tools for this thread: ${String(error)}`);
      return { tools: [], skills: [] };
    }
  });

  registerRpc(bb, readyHub);
  registerProviderEnv(bb);
  registerCli(bb, { store, connections, hub: readyHub });
  registerServices(bb, { store, connections, hub: readyHub, log });

  // `bb.status` reaches `bb plugin list` and the BB UI without the panel being
  // open - which is the only way a dead grant is visible to someone who is not
  // already looking at MCP. The SDK clears it on every load, so it is
  // re-asserted from each place the answer can change.
  let flaggedForAuth = false;
  let reloadScheduled = false;

  /**
   * The SDK has no way to clear `needs-configuration` short of a load, and a
   * user who has just reconnected should not be told the plugin still needs
   * configuring. A reload is cheap here - nothing on the load path talks to a
   * server - but it cancels pending interactions, so it waits for every
   * thread to be idle first.
   */
  function scheduleRecoveryReload(): void {
    if (reloadScheduled) return;
    reloadScheduled = true;
    setTimeout(() => {
      void (async () => {
        try {
          const running = await bb.sdk.threads.listRunning();
          if (running.length > 0) {
            // Try again later; the flag stays until a quiet moment.
            reloadScheduled = false;
            return;
          }
          await bb.sdk.plugins.reload({ pluginId: bb.pluginId });
        } catch {
          // Nothing to recover from a failed reload.
        }
      })();
    }, 1500);
  }

  function reportStatus(): void {
    try {
      const broken = store
        .listServers()
        .filter((server) => server.enabled && connections.status(server.id).state === "needs-auth");
      if (broken.length === 0) {
        if (flaggedForAuth) {
          flaggedForAuth = false;
          scheduleRecoveryReload();
        }
        return;
      }
      flaggedForAuth = true;
      bb.status.needsConfiguration(
        broken.length === 1
          ? `MCP server "${broken[0].name}" needs you to sign in again.`
          : `${broken.length} MCP servers need you to sign in again: ${broken
              .map((server) => server.name)
              .join(", ")}.`,
      );
    } catch {
      // Background work may outlive the load; a status line is never worth
      // taking the host down with.
    }
  }
  reportStatus();

  // Dispose hooks run before BB drains in-flight invocations, so this is the
  // only place that reliably reaps MCP clients and stdio children.
  bb.onDispose(async () => {
    for (const timer of pendingSyncs.values()) clearTimeout(timer);
    pendingSyncs.clear();
    await connections.closeAll();
    await stdio.killAll();
  });
}
