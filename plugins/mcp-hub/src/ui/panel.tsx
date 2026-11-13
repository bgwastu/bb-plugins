// The management page: one line per server, one primary action, and everything
// else one click deeper. Deliberately not a dashboard - there is no token
// estimate, no schema size, no project matrix, because none of those are
// questions anyone asked when adding a server.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServerView, ToolProblem, ToolView } from "../../contract.js";
import { currentOrigin, errorText, useSnapshot } from "./data.js";
import { useApi } from "./rpc.js";
import { ServerDetail } from "./server-detail.js";
import { ServerFormDialog } from "./server-form.js";
import { ToolTestDialog } from "./tool-test.js";

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

function targetOf(server: ServerView): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].filter(Boolean).join(" ")
    : (server.url ?? "");
}

function StateDot({ server }: { server: ServerView }) {
  const tone =
    server.state === "needs-auth" || server.state === "failed"
      ? "bg-amber-500"
      : !server.enabled
        ? "bg-muted-foreground/30"
        : server.state === "ready"
          ? "bg-emerald-500"
          : server.state === "connecting"
            ? "bg-sky-500 animate-pulse"
            : "bg-muted-foreground/40";
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

function stateLabel(server: ServerView): string {
  if (!server.enabled) return "Off";
  if (server.state === "needs-auth") return "Sign-in needed";
  if (server.state === "failed") return "Error";
  if (server.state === "connecting") return "Connecting";
  if (server.state === "ready") return "Connected";
  return "Not connected";
}

function OAuthCallback({ subPath, onDone }: { subPath: string; onDone(): void }) {
  const rpc = useApi();
  const [message, setMessage] = useState("Finishing sign-in…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const query = subPath.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error_description") ?? params.get("error");

    void (async () => {
      if (error) {
        setFailed(true);
        setMessage(`The provider refused the sign-in: ${error}`);
        return;
      }
      if (!code) {
        setFailed(true);
        setMessage("This sign-in link has no authorization code.");
        return;
      }
      try {
        const found = state ? await rpc.oauthResolve({ state }) : { id: null };
        if (!found.id) {
          setFailed(true);
          setMessage("This sign-in was already finished, or it belongs to another BB server.");
          return;
        }
        const result = await rpc.oauthComplete({
          id: found.id,
          code,
          ...(currentOrigin() ? { origin: currentOrigin() } : {}),
        });
        if (result.error) {
          setFailed(true);
          setMessage(result.error);
          return;
        }
        setMessage(`Connected. ${result.tools} tool${result.tools === 1 ? "" : "s"} found.`);
        // Strip the code from the URL so a refresh does not replay it.
        window.history.replaceState(null, "", window.location.pathname);
        setTimeout(onDone, 700);
      } catch (caught) {
        setFailed(true);
        setMessage(errorText(caught));
      }
    })();
  }, [rpc, subPath, onDone]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <p className={`text-sm ${failed ? "text-destructive" : ""}`}>{message}</p>
        <Button variant="outline" size="sm" onClick={onDone}>
          Back to MCP servers
        </Button>
      </div>
    </div>
  );
}

export function McpPanel({ subPath }: { subPath: string }) {
  const rpc = useApi();
  const navigate = useBbNavigate();
  const { snapshot, error, loading, refresh } = useSnapshot();
  const [filter, setFilter] = useState("");
  const goToPanel = useCallback(() => navigate.toPluginPanel("mcp-hub"), [navigate]);
  const [editing, setEditing] = useState<ServerView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [testing, setTesting] = useState<{ server: ServerView; tool: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (subPath.startsWith("oauth/callback")) {
    return <OAuthCallback subPath={subPath} onDone={goToPanel} />;
  }

  const servers = (snapshot?.servers ?? []).filter((server) =>
    filter.trim().length === 0 || server.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const broken = (snapshot?.servers ?? []).filter(
    (server) => server.enabled && (server.state === "needs-auth" || server.state === "failed"),
  );
  const tools: ToolView[] = snapshot?.tools ?? [];
  const problems: ToolProblem[] = snapshot?.problems ?? [];

  async function syncAll(): Promise<void> {
    setBusy("sync");
    setNotice(null);
    try {
      const result = await rpc.serverSyncAll();
      setNotice(
        `Read ${result.tools} tools from ${result.servers} server${result.servers === 1 ? "" : "s"}${
          result.failed > 0 ? `; ${result.failed} failed` : ""
        }.`,
      );
      await refresh();
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function connect(server: ServerView): Promise<void> {
    setBusy(server.id);
    setNotice(null);
    try {
      const result = await rpc.serverConnect({
        id: server.id,
        ...(currentOrigin() ? { origin: currentOrigin() } : {}),
      });
      if (result.authorizationUrl) {
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (result.error) setNotice(`${server.name}: ${result.error}`);
      await refresh();
    } catch (caught) {
      setNotice(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const openServer = servers.find((server) => server.id === openId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">MCP servers</h1>
          <p className="text-[11px] text-muted-foreground">
            {snapshot ? `${servers.length} configured · ${snapshot.offered} tools offered to agents` : "Loading…"}
          </p>
        </div>
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter"
          className="h-8 w-32 text-xs"
        />
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void syncAll()}>
          {busy === "sync" ? "Syncing…" : "Refresh all"}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Add server
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {notice ? (
          <div className="mb-3 rounded-md border px-3 py-2 text-xs">{notice}</div>
        ) : null}
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {broken.length > 0 ? (
          <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            {broken.length === 1
              ? `${broken[0].name} needs a sign-in. Open it and press Connect.`
              : `${broken.length} servers need a sign-in: ${broken.map((server) => server.name).join(", ")}.`}
          </div>
        ) : null}
        {snapshot?.truncated ? (
          <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            {snapshot.offered} tools are on, but a session carries at most 256. Turn some off to choose
            which ones agents see.
          </div>
        ) : null}

        {loading && !snapshot ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null}

        {!loading && servers.length === 0 ? (
          <div className="mt-10 space-y-2 text-center">
            <p className="text-sm">No MCP servers yet.</p>
            <p className="text-xs text-muted-foreground">
              Add a local command or a hosted endpoint and its tools appear in every thread.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Add server
            </Button>
          </div>
        ) : null}

        <div className="space-y-1">
          {servers.map((server) => {
            const count = server.toolCount ?? 0;
            return (
              <div
                key={server.id}
                className="group flex items-center gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-muted/40"
              >
                <StateDot server={server} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setOpenId(server.id)}
                >
                  <span className="block truncate text-sm">{server.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {targetOf(server)}
                  </span>
                </button>
                <div className="hidden shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                  <p>{stateLabel(server)}</p>
                  <p>
                    {count} tool{count === 1 ? "" : "s"} · {timeAgo(server.lastSeenAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={busy === server.id}
                  onClick={() =>
                    server.state === "ready" || server.state === "needs-auth"
                      ? void connect(server)
                      : void connect(server)
                  }
                >
                  {busy === server.id
                    ? "…"
                    : server.state === "ready"
                      ? "Reconnect"
                      : server.state === "needs-auth"
                        ? "Connect"
                        : "Test"}
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <ServerDetail
        server={openServer}
        tools={tools}
        problems={problems}
        onClose={() => setOpenId(null)}
        onEdit={() => {
          if (!openServer) return;
          setEditing(openServer);
          setFormOpen(true);
        }}
        onChanged={() => void refresh()}
        onTest={(tool) => {
          if (!openServer) return;
          setTesting({ server: openServer, tool });
        }}
      />

      <ServerFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        server={editing}
        onSaved={() => void refresh()}
      />

      {testing ? (
        <ToolTestDialog
          key={`${testing.server.id}-${testing.tool ?? "any"}`}
          open
          onOpenChange={(open) => {
            if (!open) {
              setTesting(null);
              void refresh();
            }
          }}
          server={testing.server}
          tools={tools.filter((tool) => tool.serverId === testing.server.id)}
          initialTool={testing.tool}
        />
      ) : null}
    </div>
  );
}
