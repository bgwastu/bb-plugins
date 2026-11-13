// Background work: connect at startup, then a sweep as a backstop.
//
// Connecting at startup is what makes a server added in the panel usable
// without a reload, and what turns a dead grant into a recorded error while
// nobody is waiting on an answer. The cron is not the mechanism any more; it
// is the safety net for a server that never said `tools/list_changed` and
// whose tools moved under us.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "../storage/store.js";
import type { ConnectionManager } from "../mcp/connection.js";
import type { Hub } from "./hub.js";

export interface ServicesDeps {
  store: Store;
  connections: ConnectionManager;
  hub: Hub;
  log: { warn(message: string): void };
}

/** Resolves when `signal` aborts, which is how a service stays alive. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function registerServices(bb: BbPluginApi, deps: ServicesDeps): void {
  bb.background.service("connections", {
    async start(signal) {
      // Sequential on purpose: a dozen stdio servers starting at once is a
      // dozen login shells resolving PATH at once.
      void (async () => {
        for (const server of deps.store.listServers()) {
          if (!server.enabled || signal.aborted) continue;
          try {
            await deps.hub.sync(server);
          } catch (error) {
            deps.log.warn(
              `MCP server "${server.name}" did not connect: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      })();
      await untilAborted(signal);
    },
  });

  bb.background.schedule("catalog-refresh", "*/17 * * * *", async () => {
    const result = await deps.hub.syncAll();
    if (result.failed > 0) {
      deps.log.warn(`${result.failed} MCP server(s) could not be read during the catalog refresh`);
    }
  });
}
