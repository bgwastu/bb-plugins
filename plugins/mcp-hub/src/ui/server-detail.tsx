// One server, opened: what it is, whether it works, every tool with a switch,
// and the calls it has answered. This is where the density lives, because it
// is opened deliberately - the list itself stays one line per server.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { CallView, ServerView, ToolProblem, ToolView } from "../../contract.js";
import { errorText } from "./data.js";
import { useApi } from "./rpc.js";

function timeAgo(at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ServerDetail(props: {
  server: ServerView | null;
  tools: ToolView[];
  problems: ToolProblem[];
  onClose(): void;
  onEdit(): void;
  onChanged(): void;
  onTest(tool: string | null): void;
}) {
  const rpc = useApi();
  const [calls, setCalls] = useState<CallView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const server = props.server;
  const serverId = server?.id ?? null;

  const loadCalls = useCallback(async () => {
    if (!serverId) return;
    try {
      const result = await rpc.calls({ serverId, limit: 20 });
      setCalls(result.calls);
    } catch {
      setCalls([]);
    }
  }, [rpc, serverId]);

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  if (!server) return null;

  async function act(name: string, run: () => Promise<unknown>): Promise<void> {
    setBusy(name);
    setError(null);
    try {
      await run();
      props.onChanged();
      void loadCalls();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const tools = props.tools.filter((tool) => tool.serverId === server.id);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={`size-2 rounded-full ${
                server.state === "ready"
                  ? "bg-emerald-500"
                  : server.state === "needs-auth" || server.state === "failed"
                    ? "bg-amber-500"
                    : "bg-muted-foreground/40"
              }`}
            />
            {server.name}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">
            {server.transport === "stdio"
              ? [server.command, ...server.args].filter(Boolean).join(" ")
              : server.url}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act("connect", () =>
                  rpc.serverConnect({ id: server.id, origin: window.location.origin }),
                )
              }
            >
              {busy === "connect" ? "Connecting…" : server.state === "ready" ? "Reconnect" : "Connect"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || tools.length === 0}
              onClick={() => props.onTest(null)}
            >
              Test
            </Button>
            <Button size="sm" variant="outline" onClick={props.onEdit}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act("enabled", () => rpc.serverEnabled({ id: server.id, enabled: !server.enabled }))
              }
            >
              {server.enabled ? "Turn off" : "Turn on"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Remove "${server.name}"? Its tools disappear from every thread.`)) return;
                void act("remove", async () => {
                  await rpc.serverRemove({ id: server.id });
                  props.onClose();
                });
              }}
            >
              Remove
            </Button>
          </div>

          {server.error ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
              <p className="text-amber-700 dark:text-amber-400">{server.error}</p>
              {server.authorizationUrl ? (
                <a
                  className="mt-1 inline-block underline underline-offset-2"
                  href={server.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Finish signing in
                </a>
              ) : null}
            </div>
          ) : null}

          {!server.enabled ? (
            <p className="text-xs text-muted-foreground">
              Turned off: none of its tools reach any thread.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{server.auth === "oauth" ? "OAuth" : server.auth === "bearer" ? "Bearer token" : server.auth === "headers" ? "Custom headers" : "No authentication"}</span>
            <span>{tools.length} tools</span>
            <span>last seen {timeAgo(server.lastSeenAt)}</span>
            {server.protocol ? <span>{server.protocol.toUpperCase()}</span> : null}
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Tools</p>
            {tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No tools yet. Press Connect to read them from the server.
              </p>
            ) : null}
            {tools.map((tool) => {
              const problem = props.problems.find((entry) => entry.name === tool.name)?.reason ?? tool.problem;
              return (
                <div key={tool.name} className="rounded-md border">
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <Switch
                      checked={tool.enabled}
                      disabled={problem !== null}
                      onCheckedChange={(checked) =>
                        void act(`tool-${tool.name}`, () =>
                          rpc.toolEnabled({ names: [tool.name], enabled: checked }),
                        )
                      }
                      title={tool.enabled ? "On in every thread" : "Off in every thread"}
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setExpanded(expanded === tool.name ? null : tool.name)}
                    >
                      <span className="block truncate font-mono text-xs">{tool.upstreamName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {(tool.title ?? tool.description.slice(0, 100)) || "no description"}
                      </span>
                    </button>
                    {tool.missing ? (
                      <span className="shrink-0 text-[10px] text-amber-600">gone from server</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 shrink-0 px-1.5 text-[11px]"
                      onClick={() => props.onTest(tool.name)}
                    >
                      Run
                    </Button>
                  </div>
                  {expanded === tool.name ? (
                    <div className="space-y-1 border-t px-2.5 py-2">
                      <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">
                        {tool.description || "No description."}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        registered as {tool.name}
                        {tool.readOnly ? " · read-only" : ""}
                      </p>
                      {problem ? (
                        <p className="text-[11px] text-amber-600">
                          Not offered to agents: {problem}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Recent calls</p>
              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void loadCalls()}>
                Refresh
              </Button>
            </div>
            {calls.length === 0 ? (
              <p className="text-xs text-muted-foreground">No calls yet.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {calls.map((call) => (
                  <div key={call.id} className="px-2.5 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono">{call.tool}</span>
                      <span className={call.ok ? "text-emerald-600" : "text-destructive"}>
                        {call.ok ? "ok" : "failed"} · {call.durationMs}ms · {timeAgo(call.at)}
                      </span>
                    </div>
                    {call.error ? <p className="text-muted-foreground">{call.error}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
