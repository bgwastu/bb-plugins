import React, { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { MiseOutdatedItem } from "../lib/types";
import type { UpgradeJob } from "../lib/types";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

interface UpdatesTabProps {
  outdated: MiseOutdatedItem[];
  loading: boolean;
  revalidating?: boolean;
  machineName?: string;
  onRefresh: () => void;
  hostId?: string;
  activeUpgradeJob?: UpgradeJob | null;
  onStartUpgrade: (tools?: string[]) => Promise<void>;
  onOpenUpgradeModal: () => void;
}

export function UpdatesTab({
  outdated: initialOutdated,
  loading,
  revalidating,
  machineName,
  onRefresh,
  hostId,
  activeUpgradeJob,
  onStartUpgrade,
  onOpenUpgradeModal,
}: UpdatesTabProps) {
  // Local outdated state for instant optimistic updates
  const [localOutdated, setLocalOutdated] = useState<MiseOutdatedItem[]>(initialOutdated);

  // Keep local state in sync when parent props update
  React.useEffect(() => {
    setLocalOutdated(initialOutdated);
  }, [initialOutdated]);

  const isUpgrading = activeUpgradeJob?.status === "running";

  const handleUpgradeSingle = async (toolName: string) => {
    if (isUpgrading) return;
    await onStartUpgrade([toolName]);
  };

  const handleUpgradeAll = async () => {
    if (isUpgrading || localOutdated.length === 0) return;
    await onStartUpgrade();
  };

  return (
    <div className="space-y-4">
      {/* Outdated Tools Section */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Outdated Packages ({localOutdated.length})
            </span>
            {revalidating && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1 font-medium">
                <Icon name="RotateCcw" className="size-3 animate-spin text-primary" />
                Checking {machineName || "machine"}…
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isUpgrading && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onOpenUpgradeModal}
                className="h-7 text-xs px-2.5 gap-1.5 border-primary/40 text-primary hover:bg-primary/10"
              >
                <Icon name="Terminal" className="size-3 text-primary" />
                <span>View Output</span>
              </Button>
            )}

            {localOutdated.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant={isUpgrading ? "secondary" : "default"}
                onClick={handleUpgradeAll}
                disabled={isUpgrading}
                className="h-7 text-xs px-2.5 gap-1.5"
              >
                {isUpgrading ? (
                  <>
                    <Icon name="RotateCcw" className="size-3 animate-spin text-primary" />
                    <span>Upgrading…</span>
                  </>
                ) : (
                  <span>Upgrade All ({localOutdated.length})</span>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Mobile View (< md) */}
        <div className="md:hidden space-y-2">
          {loading && localOutdated.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground text-xs font-sans space-y-2">
              <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary" />
              <div>Checking for updates on {machineName || "machine"}…</div>
            </div>
          ) : localOutdated.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-xs font-sans">
              All tools are up to date on {machineName || "this machine"}.
            </div>
          ) : (
            localOutdated.map((item) => (
              <div
                key={item.name}
                className="p-3 rounded-lg border border-border bg-card space-y-2 font-mono text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground truncate">{item.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpgradeSingle(item.name)}
                    disabled={isUpgrading}
                    className="h-6 text-[11px] px-2 font-sans"
                  >
                    {isUpgrading ? "Upgrading…" : "Update"}
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{item.current}</span>
                  <span>→</span>
                  <span className="text-foreground font-semibold">{item.latest}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Desktop Table (md+) */}
        <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-left text-xs border-collapse font-mono">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] font-sans font-normal text-muted-foreground">
                <th className="py-2.5 px-4 font-normal">Tool</th>
                <th className="py-2.5 px-4 font-normal">Current</th>
                <th className="py-2.5 px-4 font-normal">Target</th>
                <th className="py-2.5 px-4 text-right font-normal font-sans">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {loading && localOutdated.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-muted-foreground font-sans space-y-2">
                    <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary mb-2" />
                    <div>Checking for updates on {machineName || "machine"}…</div>
                  </td>
                </tr>
              ) : localOutdated.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-muted-foreground font-sans">
                    All tools are up to date on {machineName || "this machine"}.
                  </td>
                </tr>
              ) : (
                localOutdated.map((item) => (
                  <tr key={item.name} className="hover:bg-muted/15 transition-colors">
                    <td className="py-2.5 px-4 font-medium text-foreground">
                      {item.name}
                    </td>
                    <td className="py-2.5 px-4 text-muted-foreground">{item.current}</td>
                    <td className="py-2.5 px-4 text-foreground font-medium">{item.latest}</td>
                    <td className="py-2.5 px-4 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleUpgradeSingle(item.name)}
                        disabled={isUpgrading}
                        className="h-6 text-[11px] px-2 font-sans"
                      >
                        {isUpgrading ? "Upgrading…" : "Update"}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
