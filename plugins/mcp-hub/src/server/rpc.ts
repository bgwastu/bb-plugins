// The panel's only way in. One handler per contract method, no logic: what a
// server is belongs to hub.ts, and this file exists so the RPC surface cannot
// grow its own copy of it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { contract } from "../../contract.js";
import type { Hub } from "./hub.js";

export function registerRpc(bb: BbPluginApi, hub: Hub): void {
  bb.rpc.register(contract, {
    snapshot: (input) => hub.snapshot(input.origin),

    server_create: (input) => hub.createServer(input, input.origin),
    server_update: (input) => hub.updateServer(input, input.origin),
    server_remove: (input) => hub.removeServer(input.id).then(() => ({})),
    server_enabled: (input) => {
      hub.setServerEnabled(input.id, input.enabled);
      return {};
    },

    server_sync: (input) => hub.syncById(input.id),

    server_sync_all: () => hub.syncAll(),
    server_connect: (input) => hub.connect(input.id, input.origin),
    server_disconnect: (input) => hub.disconnect(input.id).then(() => ({})),
    oauth_resolve: (input) => ({ id: hub.resolveOAuthState(input.state) }),
    oauth_complete: (input) => hub.completeOAuth(input.id, input.code, input.origin),

    tool_enabled: (input) => ({ updated: hub.setToolEnabled(input.names, input.enabled) }),

    tool_call: async (input) => {
      const outcome = await hub.runTool({
        serverId: input.serverId,
        tool: input.tool,
        arguments: input.arguments,
      });
      return {
        content: outcome.result.content,
        isError: outcome.result.isError,
        durationMs: outcome.durationMs,
      };
    },

    calls: (input) => ({ calls: hub.calls(input.serverId, input.limit) }),

    selection_get: (input) => hub.selection(input.threadId, input.projectId),
    selection_set: (input) => hub.saveSelection(input),
  });
}
