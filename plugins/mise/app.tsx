import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, MiseMachine } from "./server";
import {
  MISE_STATE_CHANGED,
  MISE_UPGRADE_EVENT,
  type MiseOutdatedItem,
  type MiseTaskItem,
  type MiseToolItem,
  type UpgradeJob,
} from "./lib/types";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { ToolsTab } from "./components/ToolsTab";
import { UpdatesTab } from "./components/UpdatesTab";
import { TasksTab } from "./components/TasksTab";
import { ConfigEnvTab } from "./components/ConfigEnvTab";
import { AddToolModal } from "./components/AddToolModal";
import { UpgradeModal } from "./components/UpgradeModal";

type ActiveTab = "tools" | "updates" | "tasks" | "config";

interface MachineCacheEntry {
  tools: MiseToolItem[];
  outdated: MiseOutdatedItem[];
  tasks: MiseTaskItem[];
  envVars: Record<string, string>;
  fetchedAt: number;
}

const clientCache = new Map<string, MachineCacheEntry>();

interface PluginUiState {
  activeTab: ActiveTab;
  refreshing: boolean;
  loading: boolean;
  outdatedCount: number;
  addModalOpen: boolean;
  upgradeModalOpen: boolean;
  refetchTrigger: number;
  forceRefresh: boolean;
  selectedHostId: string | null;
  machines: MiseMachine[];
  activeUpgradeJob: UpgradeJob | null;
}

let pluginUiState: PluginUiState = {
  activeTab: "tools",
  refreshing: false,
  loading: true,
  outdatedCount: 0,
  addModalOpen: false,
  upgradeModalOpen: false,
  refetchTrigger: 0,
  forceRefresh: false,
  selectedHostId: null,
  machines: [],
  activeUpgradeJob: null,
};

const uiListeners = new Set<() => void>();

function updateUiState(patch: Partial<PluginUiState>) {
  pluginUiState = { ...pluginUiState, ...patch };
  uiListeners.forEach((l) => l());
}

function usePluginUiStore() {
  return useSyncExternalStore(
    (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    () => pluginUiState,
    () => pluginUiState,
  );
}

/** Header Actions rendered directly into BB's native top title bar */
function MiseHeaderActions() {
  const store = usePluginUiStore();

  const handleRefresh = () => {
    updateUiState({
      forceRefresh: true,
      refetchTrigger: store.refetchTrigger + 1,
    });
  };

  const handleSelectMachine = (hostId: string) => {
    if (hostId === store.selectedHostId) return;

    const cached = clientCache.get(hostId);
    if (cached) {
      updateUiState({
        selectedHostId: hostId,
        loading: false,
        refreshing: true,
        outdatedCount: cached.outdated.length,
        forceRefresh: false,
        refetchTrigger: store.refetchTrigger + 1,
      });
    } else {
      updateUiState({
        selectedHostId: hostId,
        loading: true,
        refreshing: false,
        outdatedCount: 0,
        forceRefresh: false,
        refetchTrigger: store.refetchTrigger + 1,
      });
    }
  };

  const isUpgrading = store.activeUpgradeJob?.status === "running";

  return (
    <div className="flex items-center gap-2">
      {/* Machine Selector with Live Activity Indicator */}
      {store.machines.length > 0 && (
        <div className="flex items-center gap-1.5 bg-muted/60 hover:bg-muted border border-border rounded px-2 py-1 text-xs transition-colors">
          <Icon
            name={store.refreshing ? "RotateCcw" : "Computer"}
            className={`size-3.5 text-muted-foreground ${
              store.refreshing ? "animate-spin text-primary" : ""
            }`}
          />
          <select
            value={store.selectedHostId || ""}
            onChange={(e) => handleSelectMachine(e.target.value)}
            className="bg-transparent text-foreground text-xs font-medium focus:outline-none cursor-pointer pr-1"
          >
            {store.machines.map((m) => (
              <option key={m.id} value={m.id} className="bg-popover text-popover-foreground">
                {m.name} {m.isServer ? "(server)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Upgrade in Progress Indicator in Header */}
      {isUpgrading && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => updateUiState({ upgradeModalOpen: true })}
          className="h-7 px-2.5 text-xs font-normal gap-1.5 border-primary/40 text-primary hover:bg-primary/10 animate-pulse"
          title="View upgrade progress"
        >
          <Icon name="RotateCcw" className="size-3 animate-spin" />
          <span>Upgrading…</span>
        </Button>
      )}

      {/* Add Tool Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => updateUiState({ addModalOpen: true })}
        className="h-7 px-2 text-xs font-normal gap-1"
      >
        <Icon name="SectionAdd" className="size-3.5" />
        <span className="hidden sm:inline">Add Tool</span>
      </Button>

      {/* Refresh Button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRefresh}
        disabled={store.refreshing}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
        title="Refresh (bust cache)"
      >
        <Icon
          name="RotateCcw"
          className={`size-3.5 ${store.refreshing ? "animate-spin text-primary" : ""}`}
        />
      </Button>
    </div>
  );
}

/** Main Page Component */
function MiseManagerPage() {
  const rpc = useRpc<typeof rpcContract>();
  const store = usePluginUiStore();

  const [tools, setTools] = useState<MiseToolItem[]>([]);
  const [outdated, setOutdated] = useState<MiseOutdatedItem[]>([]);
  const [tasks, setTasks] = useState<MiseTaskItem[]>([]);
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [activeJob, setActiveJob] = useState<UpgradeJob | null>(null);
  const fetchSeqRef = useRef(0);

  const selectedMachine = store.machines.find((m) => m.id === store.selectedHostId);
  const machineName = selectedMachine ? selectedMachine.name : "machine";
  const currentHostId = store.selectedHostId || undefined;

  const loadData = useCallback(
    async (forceBustCache = false) => {
      const seq = ++fetchSeqRef.current;

      try {
        let currentTargetId = pluginUiState.selectedHostId;

        // Ensure machines list is available
        if (pluginUiState.machines.length === 0) {
          const machinesList = await rpc.call("mise_list_machines", null);
          if (seq !== fetchSeqRef.current) return;

          if (Array.isArray(machinesList) && machinesList.length > 0) {
            if (!currentTargetId || !machinesList.some((m) => m.id === currentTargetId)) {
              const defaultHost =
                machinesList.find((m) => m.isServer) ||
                machinesList.find((m) => m.status === "connected") ||
                machinesList[0];
              currentTargetId = defaultHost ? defaultHost.id : null;
            }
            updateUiState({ machines: machinesList, selectedHostId: currentTargetId });
          }
        }

        if (!currentTargetId) {
          updateUiState({ loading: false, refreshing: false });
          return;
        }

        // Check active upgrade job
        rpc
          .call("mise_get_active_upgrade", { hostId: currentTargetId })
          .then((job) => {
            if (seq !== fetchSeqRef.current) return;
            setActiveJob(job);
            updateUiState({ activeUpgradeJob: job });
          })
          .catch(() => {});

        // Check client cache if not forcing bust
        const cached = clientCache.get(currentTargetId);
        if (cached && !forceBustCache) {
          setTools(cached.tools);
          setOutdated(cached.outdated);
          setTasks(cached.tasks);
          setEnvVars(cached.envVars);
          updateUiState({
            loading: false,
            refreshing: true,
            outdatedCount: cached.outdated.length,
          });
        } else if (!cached) {
          setTools([]);
          setOutdated([]);
          setTasks([]);
          setEnvVars({});
          updateUiState({ loading: true, refreshing: false });
        } else {
          updateUiState({ refreshing: true });
        }

        const hostParam = {
          hostId: currentTargetId,
          forceRefresh: forceBustCache,
        };

        // Fetch concurrently
        const [toolsList, outdatedList, tasksList, envMap] = await Promise.all([
          rpc.call("mise_list_tools", hostParam),
          rpc.call("mise_list_outdated", hostParam),
          rpc.call("mise_list_tasks", hostParam),
          rpc.call("mise_get_env", hostParam),
        ]);

        if (seq !== fetchSeqRef.current) return;

        const resolvedTools = Array.isArray(toolsList) ? toolsList : [];
        const resolvedOutdated = Array.isArray(outdatedList) ? outdatedList : [];
        const resolvedTasks = Array.isArray(tasksList) ? tasksList : [];
        const resolvedEnv = envMap && typeof envMap === "object" ? envMap : {};

        // Update Client Cache
        clientCache.set(currentTargetId, {
          tools: resolvedTools,
          outdated: resolvedOutdated,
          tasks: resolvedTasks,
          envVars: resolvedEnv,
          fetchedAt: Date.now(),
        });

        setTools(resolvedTools);
        setOutdated(resolvedOutdated);
        setTasks(resolvedTasks);
        setEnvVars(resolvedEnv);
        updateUiState({
          loading: false,
          refreshing: false,
          outdatedCount: resolvedOutdated.length,
        });
      } catch (err: any) {
        if (seq !== fetchSeqRef.current) return;
        toast.error("Failed to load mise on " + machineName + ": " + err.message);
        updateUiState({ loading: false, refreshing: false });
      }
    },
    [rpc, machineName],
  );

  useEffect(() => {
    const isForce = pluginUiState.forceRefresh;
    if (isForce) updateUiState({ forceRefresh: false });
    loadData(isForce);
  }, [loadData, store.refetchTrigger]);

  // Realtime state sync
  useRealtime(MISE_STATE_CHANGED, () => {
    clientCache.clear();
    loadData(true);
  });

  // Realtime upgrade log streaming
  useRealtime(MISE_UPGRADE_EVENT, (payload: any) => {
    if (!payload) return;
    if (payload.hostId === store.selectedHostId) {
      setActiveJob((prev) => {
        const baseLogs = prev && prev.id === payload.jobId ? prev.logs : [];
        const newLogs = payload.line ? [...baseLogs, payload.line] : baseLogs;
        const updated: UpgradeJob = {
          id: payload.jobId,
          hostId: payload.hostId,
          tools: prev?.tools,
          status: payload.status || prev?.status || "running",
          logs: newLogs,
          startedAt: prev?.startedAt || Date.now(),
          completedAt: payload.status === "completed" || payload.status === "failed" ? Date.now() : prev?.completedAt,
          message: payload.message || prev?.message,
        };
        updateUiState({ activeUpgradeJob: updated });
        return updated;
      });

      if (payload.status === "completed") {
        toast.success("Upgrade finished on " + machineName);
        clientCache.clear();
        updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 });
      } else if (payload.status === "failed") {
        toast.error("Upgrade failed on " + machineName);
      }
    }
  });

  const handleStartUpgrade = async (toolsToUpgrade?: string[]) => {
    try {
      const res = await rpc.call("mise_start_upgrade", {
        ...(toolsToUpgrade && toolsToUpgrade.length > 0 ? { tools: toolsToUpgrade } : {}),
        ...(currentHostId ? { hostId: currentHostId } : {}),
      });

      if (res?.ok) {
        const initialJob: UpgradeJob = {
          id: res.jobId,
          hostId: store.selectedHostId || "local",
          tools: toolsToUpgrade,
          status: "running",
          logs: [`[mise] Starting upgrade for ${toolsToUpgrade && toolsToUpgrade.length > 0 ? toolsToUpgrade.join(", ") : "all packages"}...`],
          startedAt: Date.now(),
        };
        setActiveJob(initialJob);
        updateUiState({ activeUpgradeJob: initialJob, upgradeModalOpen: true });
      } else {
        toast.error(res?.message || "Failed to initiate upgrade");
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    }
  };

  const handleClearUpgrade = async () => {
    try {
      await rpc.call("mise_clear_upgrade", { hostId: currentHostId });
      setActiveJob(null);
      updateUiState({ activeUpgradeJob: null });
    } catch {}
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl w-full p-4 space-y-4">
        {/* Main Tabs Navigation */}
        <div className="flex items-center gap-1 border-b border-border text-xs">
          <button
            type="button"
            onClick={() => updateUiState({ activeTab: "tools" })}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-colors cursor-pointer ${
              store.activeTab === "tools"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="Toolbox" className="size-3.5" />
            <span>Tools</span>
          </button>

          <button
            type="button"
            onClick={() => updateUiState({ activeTab: "updates" })}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-colors cursor-pointer ${
              store.activeTab === "updates"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="Download" className="size-3.5" />
            <span>Updates</span>
            {outdated.length > 0 && (
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-muted text-foreground font-mono font-medium">
                {outdated.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => updateUiState({ activeTab: "tasks" })}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-colors cursor-pointer ${
              store.activeTab === "tasks"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="Workflow" className="size-3.5" />
            <span>Tasks</span>
          </button>

          <button
            type="button"
            onClick={() => updateUiState({ activeTab: "config" })}
            className={`flex items-center gap-1.5 px-3 py-2 border-b-2 font-medium transition-colors cursor-pointer ${
              store.activeTab === "config"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon name="Settings" className="size-3.5" />
            <span>Config & Env</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="pt-1">
          {store.activeTab === "tools" && (
            <ToolsTab
              tools={tools}
              loading={store.loading}
              revalidating={store.refreshing}
              machineName={machineName}
              onRefresh={() => updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 })}
              onNavigateToUpdates={() => updateUiState({ activeTab: "updates" })}
              hostId={currentHostId}
            />
          )}

          {store.activeTab === "updates" && (
            <UpdatesTab
              outdated={outdated}
              loading={store.loading}
              revalidating={store.refreshing}
              machineName={machineName}
              onRefresh={() => updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 })}
              hostId={currentHostId}
              activeUpgradeJob={activeJob}
              onStartUpgrade={handleStartUpgrade}
              onOpenUpgradeModal={() => updateUiState({ upgradeModalOpen: true })}
            />
          )}

          {store.activeTab === "tasks" && (
            <TasksTab
              tasks={tasks}
              loading={store.loading}
              revalidating={store.refreshing}
              machineName={machineName}
              onRefresh={() => updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 })}
              hostId={currentHostId}
            />
          )}

          {store.activeTab === "config" && (
            <ConfigEnvTab
              envVars={envVars}
              loading={store.loading}
              revalidating={store.refreshing}
              machineName={machineName}
              onRefresh={() => updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 })}
              hostId={currentHostId}
            />
          )}
        </div>
      </div>

      {/* Add Tool Modal */}
      <AddToolModal
        open={store.addModalOpen}
        onOpenChange={(open) => updateUiState({ addModalOpen: open })}
        onSuccess={() => updateUiState({ forceRefresh: true, refetchTrigger: store.refetchTrigger + 1 })}
        hostId={currentHostId}
      />

      {/* Streaming Terminal Output Modal */}
      <UpgradeModal
        open={store.upgradeModalOpen}
        onOpenChange={(open) => updateUiState({ upgradeModalOpen: open })}
        job={activeJob}
        machineName={machineName}
        onDone={handleClearUpgrade}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mise-manager",
    title: "Mise",
    icon: "Package",
    path: "mise",
    component: MiseManagerPage,
    headerContent: MiseHeaderActions,
  });
});
