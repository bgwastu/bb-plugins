import React, { useState, useMemo } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { MiseTaskItem } from "../lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";

interface TasksTabProps {
  tasks: MiseTaskItem[];
  loading: boolean;
  revalidating?: boolean;
  machineName?: string;
  onRefresh: () => void;
  hostId?: string;
}

export function TasksTab({
  tasks,
  loading,
  revalidating,
  machineName,
  onRefresh,
  hostId,
}: TasksTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [filter, setFilter] = useState("");
  const [runningTask, setRunningTask] = useState<string | null>(null);

  const filteredTasks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q)) ||
        t.run.some((r) => r.toLowerCase().includes(q)),
    );
  }, [tasks, filter]);

  const handleRunTask = async (taskName: string) => {
    setRunningTask(taskName);
    try {
      const res = await rpc.call("mise_run_task_terminal", {
        task: taskName,
        hostId,
      });

      if (res?.ok) {
        toast.success(`Launched terminal for "mise run ${taskName}"`);
      } else {
        toast.error(res?.message || `Failed to run ${taskName}`);
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setRunningTask(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Search Bar & Sync indicator */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Icon
            name="Search"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
          />
          <Input
            placeholder="Search..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8 h-8 text-xs font-mono"
          />
        </div>
        {revalidating && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0 font-medium">
            <Icon name="RotateCcw" className="size-3 animate-spin text-primary" />
            <span>Syncing tasks on {machineName || "machine"}…</span>
          </div>
        )}
      </div>

      {/* Task List / Cards */}
      <div className="space-y-2">
        {loading && tasks.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-xs rounded-lg border border-border bg-card space-y-2">
            <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary mb-2" />
            <div>Loading tasks on {machineName || "machine"}…</div>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-xs rounded-lg border border-border bg-card">
            {filter.trim() ? `No tasks found matching "${filter}".` : `No tasks configured on ${machineName || "this machine"}.`}
          </div>
        ) : (
          filteredTasks.map((t) => (
            <div
              key={t.name}
              className="p-3 rounded-lg border border-border bg-card hover:border-border/80 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-xs text-foreground">
                    {t.name}
                  </span>
                  {t.depends && t.depends.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-sans font-medium bg-muted text-muted-foreground border border-border/50">
                      depends: {t.depends.join(", ")}
                    </span>
                  )}
                  {t.source && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[280px]" title={t.source}>
                      ({t.source.split("/").slice(-2).join("/")})
                    </span>
                  )}
                </div>

                {t.description && (
                  <p className="text-xs text-muted-foreground leading-normal">
                    {t.description}
                  </p>
                )}

                {t.run && t.run.length > 0 && (
                  <div className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground/80 pt-0.5">
                    <span className="text-primary font-bold">$</span>
                    <span className="truncate">{t.run.join(" && ")}</span>
                  </div>
                )}
              </div>

              <div className="shrink-0 flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleRunTask(t.name)}
                  disabled={runningTask === t.name}
                  className="h-7 text-xs font-medium px-2.5 gap-1.5"
                >
                  {runningTask === t.name ? (
                    <Icon name="Loading" className="size-3 animate-spin" />
                  ) : (
                    <Icon name="Terminal" className="size-3" />
                  )}
                  Run in Terminal
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
