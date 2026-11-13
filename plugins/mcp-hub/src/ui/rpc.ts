// The typed facade over `useRpc`. The SDK client exposes one `call(method, …)`;
// this module names each method once so a component cannot typo a method and
// every argument is checked against the contract.
import { useMemo } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { McpContract } from "../../contract.js";

export function useApi() {
  const rpc = useRpc<McpContract>();
  return useMemo(
    () => ({
      snapshot: (input: { origin?: string }) => rpc.call("snapshot", input),
      serverCreate: (input: Parameters<typeof rpc.call<"server_create">>[1]) =>
        rpc.call("server_create", input),
      serverUpdate: (input: Parameters<typeof rpc.call<"server_update">>[1]) =>
        rpc.call("server_update", input),
      serverRemove: (input: { id: string }) => rpc.call("server_remove", input),
      serverEnabled: (input: { id: string; enabled: boolean }) => rpc.call("server_enabled", input),
      serverSync: (input: { id: string }) => rpc.call("server_sync", input),
      serverSyncAll: () => rpc.call("server_sync_all", {}),
      serverConnect: (input: { id: string; origin?: string }) => rpc.call("server_connect", input),
      serverDisconnect: (input: { id: string }) => rpc.call("server_disconnect", input),
      oauthResolve: (input: { state: string }) => rpc.call("oauth_resolve", input),
      oauthComplete: (input: { id: string; code: string; origin?: string }) =>
        rpc.call("oauth_complete", input),
      toolEnabled: (input: { names: string[]; enabled: boolean }) => rpc.call("tool_enabled", input),
      toolCall: (input: { serverId: string; tool: string; arguments: Record<string, unknown> }) =>
        rpc.call("tool_call", input),
      calls: (input: { serverId: string; limit: number }) => rpc.call("calls", input),
      selectionGet: (input: { threadId?: string; projectId?: string }) =>
        rpc.call("selection_get", input),
      selectionSet: (input: {
        threadId?: string;
        projectId?: string;
        servers: Record<string, boolean>;
        tools: Record<string, boolean>;
        clearedServers: string[];
        clearedTools: string[];
        apply: boolean;
        interrupt: boolean;
      }) => rpc.call("selection_set", input),
    }),
    [rpc],
  );
}

export type Api = ReturnType<typeof useApi>;
