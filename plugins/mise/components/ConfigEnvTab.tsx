import React, { useState, useEffect, useMemo } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";

interface ConfigEnvTabProps {
  envVars: Record<string, string>;
  loading: boolean;
  revalidating?: boolean;
  machineName?: string;
  onRefresh: () => void;
  hostId?: string;
}

export function ConfigEnvTab({
  envVars,
  loading,
  revalidating,
  machineName,
  onRefresh,
  hostId,
}: ConfigEnvTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [subView, setSubView] = useState<"env" | "config">("env");
  const [envFilter, setEnvFilter] = useState("");
  const [selectedFile, setSelectedFile] = useState<string>("mise.toml");
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [savingFile, setSavingFile] = useState(false);

  const configFiles = [
    {
      id: "universe",
      label: "Fleet / Universe (mise.toml)",
      path: "mise.toml",
    },
    {
      id: "global",
      label: "Global (~/.config/mise/config.toml)",
      path: "~/.config/mise/config.toml",
    },
  ];

  // Load config file content
  useEffect(() => {
    if (subView !== "config") return;
    let active = true;
    setFileLoading(true);

    rpc
      .call("mise_read_config", { filePath: selectedFile, hostId })
      .then((res) => {
        if (!active) return;
        if (res?.content !== undefined) {
          setFileContent(res.content);
        } else {
          setFileContent("# File not found or empty");
        }
      })
      .catch((err) => {
        if (active) setFileContent(`# Error reading file: ${err.message}`);
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });

    return () => {
      active = false;
    };
  }, [rpc, selectedFile, subView, hostId]);

  const handleSaveConfig = async () => {
    setSavingFile(true);
    try {
      const res = await rpc.call("mise_write_config", {
        filePath: selectedFile,
        content: fileContent,
        hostId,
      });

      if (res?.ok) {
        toast.success(res.message);
        onRefresh();
      } else {
        toast.error(res?.message || "Failed to save file");
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setSavingFile(false);
    }
  };

  // Exploded PATH entries
  const pathEntries = useMemo(() => {
    const rawPath = envVars["PATH"] || "";
    return rawPath
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
  }, [envVars]);

  // Filtered env vars
  const filteredEnv = useMemo(() => {
    const q = envFilter.trim().toLowerCase();
    const entries = Object.entries(envVars).filter(([k]) => k !== "PATH");
    if (!q) return entries;
    return entries.filter(
      ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
    );
  }, [envVars, envFilter]);

  return (
    <div className="space-y-3">
      {/* Sub-View Switcher */}
      <div className="flex items-center gap-2 border-b border-border pb-2.5">
        <Button
          type="button"
          variant={subView === "env" ? "default" : "ghost"}
          size="sm"
          onClick={() => setSubView("env")}
          className="h-7 text-xs font-normal"
        >
          Environment Variables ({Object.keys(envVars).length})
        </Button>
        <Button
          type="button"
          variant={subView === "config" ? "default" : "ghost"}
          size="sm"
          onClick={() => setSubView("config")}
          className="h-7 text-xs font-normal"
        >
          Configuration Files
        </Button>
      </div>

      {subView === "env" ? (
        <div className="space-y-4">
          {/* Exploded PATH breakdown */}
          <div className="rounded-lg border border-border bg-card p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-xs text-foreground uppercase tracking-wider">
                PATH Precedence ({pathEntries.length} entries)
              </span>
              <span className="text-[11px] text-muted-foreground font-sans">
                Top to bottom
              </span>
            </div>

            <div className="space-y-1 font-mono text-xs max-h-60 overflow-y-auto pr-1">
              {pathEntries.map((p, idx) => {
                const isMiseShim = p.includes(".local/share/mise/shims");
                const isMiseInstall = p.includes(".local/share/mise/installs");
                return (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-border/40 text-[11px] hover:bg-muted/20"
                  >
                    <span className="truncate flex-1 text-foreground">
                      <span className="text-muted-foreground mr-2 font-sans text-[10px]">
                        {idx + 1}.
                      </span>
                      {p}
                    </span>
                    {isMiseShim && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono text-muted-foreground bg-muted border border-border/50">
                        shims
                      </span>
                    )}
                    {isMiseInstall && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono text-muted-foreground bg-muted border border-border/50">
                        mise
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Other Env Vars */}
          <div className="space-y-2.5">
            <div className="relative max-w-sm">
              <Icon
                name="Search"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
              />
              <Input
                placeholder="Search..."
                value={envFilter}
                onChange={(e) => setEnvFilter(e.target.value)}
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>

            {/* Mobile View (< md) */}
            <div className="md:hidden space-y-2">
              {loading && Object.keys(envVars).length === 0 ? (
                <div className="py-12 text-center text-muted-foreground text-xs font-sans space-y-2">
                  <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary mb-2" />
                  <div>Loading environment variables on {machineName || "machine"}…</div>
                </div>
              ) : filteredEnv.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-xs font-sans">
                  {envFilter.trim()
                    ? `No environment variables matching "${envFilter}".`
                    : `No environment variables found on ${machineName || "this machine"}.`}
                </div>
              ) : (
                filteredEnv.map(([k, v]) => (
                  <div key={k} className="p-2.5 rounded border border-border bg-card font-mono text-xs space-y-1">
                    <div className="font-semibold text-foreground break-all">{k}</div>
                    <div className="text-[11px] text-muted-foreground break-all select-all">{v}</div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table (md+) */}
            <div className="hidden md:block rounded-lg border border-border bg-card overflow-hidden">
              <table className="w-full text-left text-xs border-collapse font-mono">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-[11px] font-sans font-normal text-muted-foreground">
                    <th className="py-2.5 px-4 font-normal w-1/3">Variable</th>
                    <th className="py-2.5 px-4 font-normal w-2/3">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {loading && Object.keys(envVars).length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-12 text-center text-muted-foreground font-sans space-y-2">
                        <Icon name="RotateCcw" className="size-5 animate-spin mx-auto text-primary mb-2" />
                        <div>Loading environment variables on {machineName || "machine"}…</div>
                      </td>
                    </tr>
                  ) : filteredEnv.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-8 text-center text-muted-foreground font-sans">
                        {envFilter.trim()
                          ? `No environment variables matching "${envFilter}".`
                          : `No environment variables found on ${machineName || "this machine"}.`}
                      </td>
                    </tr>
                  ) : (
                    filteredEnv.map(([k, v]) => (
                      <tr key={k} className="hover:bg-muted/15 transition-colors">
                        <td className="py-2 px-4 font-medium text-foreground break-all">{k}</td>
                        <td className="py-2 px-4 text-muted-foreground break-all select-all">
                          {v}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* Config File Viewer & Editor */
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {configFiles.map((file) => (
                <Button
                  key={file.id}
                  type="button"
                  variant={selectedFile === file.path ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedFile(file.path)}
                  className="h-7 text-xs font-mono"
                >
                  {file.label}
                </Button>
              ))}
            </div>

            <Button
              type="button"
              size="sm"
              onClick={handleSaveConfig}
              disabled={savingFile || fileLoading}
              className="h-7 text-xs px-3"
            >
              {savingFile ? "Saving…" : "Save TOML"}
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-card overflow-hidden">
            {fileLoading ? (
              <div className="py-16 text-center text-muted-foreground text-xs font-mono">
                <Icon name="Loading" className="size-4 animate-spin mx-auto mb-1.5" />
                Reading file…
              </div>
            ) : (
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                className="w-full h-[460px] p-3.5 text-xs font-mono bg-transparent text-foreground outline-none resize-y border-none leading-relaxed"
                spellCheck={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
