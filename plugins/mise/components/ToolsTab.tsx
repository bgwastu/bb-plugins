import React, { useState, useMemo } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { MiseToolItem } from "../lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ToolsTabProps {
  tools: MiseToolItem[];
  loading: boolean;
  revalidating?: boolean;
  machineName?: string;
  onRefresh: () => void;
  onNavigateToUpdates?: () => void;
  hostId?: string;
}

export function ToolsTab({
  tools,
  loading,
  revalidating,
  machineName,
  onRefresh,
  hostId,
}: ToolsTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [filter, setFilter] = useState("");
  const [switchTool, setSwitchTool] = useState<MiseToolItem | null>(null);
  const [newVersion, setNewVersion] = useState("");
  const [switching, setSwitching] = useState(false);
  const [toolToUninstall, setToolToUninstall] = useState<{ tool: string; version: string } | null>(
    null,
  );
  const [uninstalling, setUninstalling] = useState(false);

  const filteredTools = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.activeVersion && t.activeVersion.toLowerCase().includes(q)),
    );
  }, [tools, filter]);

  const handleApplyVersion = async () => {
    if (!switchTool || !newVersion.trim()) return;
    setSwitching(true);
    try {
      const res = await rpc.call("mise_use_tool", {
        tool: switchTool.name,
        version: newVersion.trim(),
        hostId,
      });

      if (res?.ok) {
        toast.success(res.message);
        setSwitchTool(null);
        setNewVersion("");
        onRefresh();
      } else {
        toast.error(res?.message || "Failed to switch version");
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setSwitching(false);
    }
  };

  const handleUninstall = async () => {
    if (!toolToUninstall) return;
    setUninstalling(true);
    try {
      const res = await rpc.call("mise_uninstall_tool", {
        tool: toolToUninstall.tool,
        version: toolToUninstall.version,
        hostId,
      });

      if (res?.ok) {
        toast.success(res.message);
        setToolToUninstall(null);
        onRefresh();
      } else {
        toast.error(res?.message || "Uninstall failed");
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setUninstalling(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Search Bar & Sync indicator */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative max-w-sm w-full">
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
            <span>Syncing {machineName || "machine"}…</span>
          </div>
        )}
      </div>

      {/* Mobile Card List (visible on mobile < md) */}
      <div className="md:hidden space-y-2">
        {loading && tools.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-xs space-y-2">
            <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary" />
            <div>Loading runtimes on {machineName || "machine"}…</div>
          </div>
        ) : filteredTools.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-xs">
            {filter.trim() ? `No tools matching "${filter}".` : `No tools installed on ${machineName || "this machine"}.`}
          </div>
        ) : (
          filteredTools.map((t) => (
            <div
              key={t.name}
              className="p-3 rounded-lg border border-border bg-card space-y-2 font-mono text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0 flex-1">
                  <span className="font-semibold text-foreground truncate">{t.name}</span>
                  {t.isOutdated && (
                    <span className="px-1.5 py-0.2 rounded text-[10px] text-muted-foreground bg-muted border border-border/50 font-sans">
                      outdated
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0 font-sans">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSwitchTool(t);
                      setNewVersion(t.activeVersion || "latest");
                    }}
                    className="h-6 px-2 text-xs"
                  >
                    Switch
                  </Button>
                  {t.activeVersion && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setToolToUninstall({ tool: t.name, version: t.activeVersion! })
                      }
                      className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Icon name="Trash2" className="size-3" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>Active:</span>
                <span className="text-foreground font-medium">{t.activeVersion || "(none)"}</span>
                {t.installedVersions.length > 1 && (
                  <>
                    <span>·</span>
                    <span className="truncate">
                      All: {t.installedVersions.join(", ")}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop Table (hidden on mobile, visible md+) */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-[11px] font-medium text-muted-foreground">
              <th className="py-2.5 px-4 font-normal">Tool / Runtime</th>
              <th className="py-2.5 px-4 font-normal">Active Version</th>
              <th className="py-2.5 px-4 font-normal">Installed Versions</th>
              <th className="py-2.5 px-4 text-right font-normal">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40 font-mono">
            {loading && tools.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-12 text-center text-muted-foreground font-sans space-y-2">
                  <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary mb-2" />
                  <div>Loading runtimes on {machineName || "machine"}…</div>
                </td>
              </tr>
            ) : filteredTools.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-10 text-center text-muted-foreground font-sans">
                  {filter.trim() ? `No runtimes found matching "${filter}".` : `No runtimes installed on ${machineName || "this machine"}.`}
                </td>
              </tr>
            ) : (
              filteredTools.map((t) => (
                <tr key={t.name} className="hover:bg-muted/15 transition-colors group">
                  {/* Tool Name */}
                  <td className="py-2.5 px-4 font-medium text-foreground">
                    <div className="flex items-center gap-2">
                      <span>{t.name}</span>
                      {t.isOutdated && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-muted-foreground bg-muted border border-border/50">
                          outdated
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Active Version */}
                  <td className="py-2.5 px-4">
                    {t.activeVersion ? (
                      <span className="font-mono text-foreground font-medium">
                        {t.activeVersion}
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic">(none)</span>
                    )}
                  </td>

                  {/* Installed Versions */}
                  <td className="py-2.5 px-4">
                    <div className="flex flex-wrap gap-1">
                      {t.installedVersions.map((v) => (
                        <span
                          key={v}
                          className={`px-1.5 py-0.5 rounded text-[11px] border ${
                            v === t.activeVersion
                              ? "bg-muted text-foreground border-border font-medium"
                              : "text-muted-foreground border-transparent"
                          }`}
                        >
                          {v}
                        </span>
                      ))}
                    </div>
                  </td>

                  {/* Actions */}
                  <td className="py-2.5 px-4 text-right font-sans">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSwitchTool(t);
                          setNewVersion(t.activeVersion || "latest");
                        }}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Switch
                      </Button>

                      {t.activeVersion && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setToolToUninstall({ tool: t.name, version: t.activeVersion! })
                          }
                          className="h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                          title="Uninstall"
                        >
                          <Icon name="Trash2" className="size-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Switch Version Modal */}
      <Dialog open={!!switchTool} onOpenChange={(open) => !open && setSwitchTool(null)}>
        <DialogContent className="max-w-md p-5 bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Switch Version: {switchTool?.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Enter a version to pin globally.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 my-2">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                Version
              </label>
              <Input
                value={newVersion}
                onChange={(e) => setNewVersion(e.target.value)}
                placeholder="e.g. latest, 22, 3.12"
                className="h-8 text-xs font-mono"
              />
            </div>

            {switchTool && switchTool.installedVersions.length > 0 && (
              <div>
                <span className="text-[11px] font-medium text-muted-foreground block mb-1.5">
                  Installed Versions:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {switchTool.installedVersions.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setNewVersion(v)}
                      className={`px-2 py-0.5 rounded text-xs font-mono border cursor-pointer ${
                        newVersion === v
                          ? "bg-foreground text-background border-foreground font-semibold"
                          : "bg-muted/40 hover:bg-muted text-foreground border-border/60"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSwitchTool(null)}
              disabled={switching}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleApplyVersion}
              disabled={switching || !newVersion.trim()}
              className="h-8 text-xs"
            >
              {switching ? "Applying…" : "Set Version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Uninstall Confirmation Modal */}
      <Dialog open={!!toolToUninstall} onOpenChange={(open) => !open && setToolToUninstall(null)}>
        <DialogContent className="max-w-md p-5 bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold text-foreground">
              Confirm Uninstall
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Remove {toolToUninstall?.tool}@{toolToUninstall?.version}?
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setToolToUninstall(null)}
              disabled={uninstalling}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleUninstall}
              disabled={uninstalling}
              className="h-8 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {uninstalling ? "Uninstalling…" : "Uninstall"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
