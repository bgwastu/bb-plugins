import React, { useEffect, useRef } from "react";
import type { UpgradeJob } from "../lib/types";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: UpgradeJob | null;
  machineName?: string;
  onDone?: () => void;
}

export function UpgradeModal({
  open,
  onOpenChange,
  job,
  machineName,
  onDone,
}: UpgradeModalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  // Auto-scroll to bottom as new logs arrive, unless user scrolled up
  useEffect(() => {
    if (!terminalRef.current || userScrolledRef.current) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [job?.logs.length]);

  const handleScroll = () => {
    if (!terminalRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    userScrolledRef.current = !isAtBottom;
  };

  const isRunning = job?.status === "running";
  const isCompleted = job?.status === "completed";

  const toolDisplay =
    job?.tools && job.tools.length > 0
      ? job.tools.join(", ")
      : "all outdated packages";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-5 bg-card border-border flex flex-col max-h-[85vh]">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2 pr-8">
            <div className="flex min-w-0 items-center gap-2">
              <Icon name="Terminal" className="size-4 text-primary" />
              <span>Mise Upgrade Output</span>
              {machineName && (
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-muted font-normal text-muted-foreground border border-border/50">
                  {machineName}
                </span>
              )}
            </div>

          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Upgrading {toolDisplay} via <code className="font-mono bg-muted/60 px-1 py-0.5 rounded">mise upgrade -y</code>
          </DialogDescription>
        </DialogHeader>

        {/* Terminal Window */}
        <div
          ref={terminalRef}
          onScroll={handleScroll}
          className="my-3 flex-1 min-h-[220px] max-h-[380px] overflow-y-auto rounded-lg bg-zinc-950 text-zinc-200 dark:bg-black p-3.5 font-mono text-[11px] leading-relaxed border border-border/60 select-text"
        >
          {(!job || job.logs.length === 0) ? (
            <div className="text-zinc-500 italic py-6 text-center">
              Waiting for terminal output…
            </div>
          ) : (
            job.logs.map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-all py-0.5 hover:bg-white/5 px-1 rounded">
                {line}
              </div>
            ))
          )}
        </div>

        {/* Footer actions */}
        <DialogFooter className="flex items-center justify-between sm:justify-between w-full pt-1">
          <div className="min-w-0 text-[11px] text-muted-foreground">
            {isRunning ? (
              <span className="flex items-center gap-1 text-primary animate-pulse">
                <Icon name="RotateCcw" className="size-3 animate-spin" />
                Running
              </span>
            ) : isCompleted ? (
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                <Icon name="CircleCheck" className="size-3.5" />
                Completed
              </span>
            ) : (
              <span className="flex items-center gap-1 text-destructive">
                <Icon name="CircleX" className="size-3.5" />
                Failed{job?.error || job?.message ? `: ${job.error || job.message}` : ""}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isRunning ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="h-7 text-xs px-3"
              >
                Close (Keep Running)
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => {
                  onDone?.();
                  onOpenChange(false);
                }}
                className="h-7 text-xs px-3"
              >
                Done
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
