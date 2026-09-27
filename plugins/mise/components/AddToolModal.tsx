import React, { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
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

interface AddToolModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  hostId?: string;
}

export function AddToolModal({ open, onOpenChange, onSuccess, hostId }: AddToolModalProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [selectedTool, setSelectedTool] = useState("");
  const [version, setVersion] = useState("latest");
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [results, setResults] = useState<Array<{ name: string; description: string }>>([]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await rpc.call("mise_search_tools", { query: query.trim(), hostId });
      setResults(Array.isArray(res) ? res : []);
    } catch (err: any) {
      toast.error("Search failed: " + err.message);
    } finally {
      setSearching(false);
    }
  };

  const handleInstall = async () => {
    const tool = selectedTool.trim() || query.trim();
    if (!tool) {
      toast.error("Please enter or select a tool name");
      return;
    }

    setInstalling(true);
    try {
      const res = await rpc.call("mise_use_tool", {
        tool,
        version: version.trim() || "latest",
        hostId,
      });

      if (res?.ok) {
        toast.success(res.message);
        onOpenChange(false);
        setQuery("");
        setSelectedTool("");
        onSuccess();
      } else {
        toast.error(res?.message || "Install failed");
      }
    } catch (err: any) {
      toast.error(err.message || String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-5 bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold flex items-center gap-2">
            <Icon name="Toolbox" className="size-4.5 text-primary" />
            Install / Pin Global Tool via Mise
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Search the mise registry (aqua, asdf, core, npm, pipx) and install globally across your machine fleet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-2">
          {/* Search Bar */}
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Icon
                name="Search"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
              />
              <Input
                placeholder="Search tools (e.g. python, node, rust, bun, uv)..."
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedTool("");
                }}
                className="pl-8 h-8 text-xs font-mono"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={searching || !query.trim()}
              className="h-8 text-xs px-3 shrink-0"
            >
              {searching ? <Icon name="Loading" className="size-3.5 animate-spin mr-1" /> : null}
              Search
            </Button>
          </form>

          {/* Search Results */}
          {results.length > 0 && (
            <div className="border border-border/50 rounded-md max-h-44 overflow-y-auto divide-y divide-border/30 bg-muted/20">
              {results.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  onClick={() => {
                    setSelectedTool(r.name);
                    setQuery(r.name);
                  }}
                  className={`w-full text-left px-3 py-2 text-xs flex flex-col transition-colors hover:bg-accent/40 ${
                    selectedTool === r.name ? "bg-primary/15 border-l-2 border-primary" : ""
                  }`}
                >
                  <span className="font-mono font-semibold text-foreground">{r.name}</span>
                  {r.description && (
                    <span className="text-[11px] text-muted-foreground line-clamp-1">
                      {r.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Version Input */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">
              Version Tag
            </label>
            <Input
              placeholder="latest, 22, 3.12, etc."
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>

        <DialogFooter className="mt-4 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={installing}
            className="h-8 text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleInstall}
            disabled={installing || (!selectedTool && !query.trim())}
            className="h-8 text-xs"
          >
            {installing ? "Installing…" : `Use ${(selectedTool || query).trim() || "Tool"} (Global)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
