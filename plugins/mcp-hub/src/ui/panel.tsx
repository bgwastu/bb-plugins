// The management page: one line per server. The switch on the right is the
// same switch the composer popup flips; everything else is one click deeper,
// in the server's own drawer.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ServerView, ToolProblem, ToolView } from "../../contract.js";
import { currentOrigin, errorText, useSnapshot } from "./data.js";
import { useApi } from "./rpc.js";
import { ServerDetail } from "./server-detail.js";
import { ServerFormDialog } from "./server-form.js";
import { ToolTestDialog } from "./tool-test.js";

function targetOf(server: ServerView): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].filter(Boolean).join(" ")
    : (server.url ?? "");
}

function StateDot({ server }: { server: ServerView }) {
  const tone =
    server.state === "needs-auth" || server.state === "failed"
      ? "bg-amber-500"
      : server.state === "ready"
        ? "bg-emerald-500"
        : server.state === "connecting"
          ? "bg-sky-500 animate-pulse"
          : "bg-muted-foreground/40";
  return <span className={`size-2 shrink-0 rounded-full ${tone}`} />;
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
          Back
        </Button>
      </div>
    </div>
  );
}

export function McpPanel({ subPath }: { subPath: string }) {
  const rpc = useApi();
  const navigate = useBbNavigate();
  const { snapshot, error, loading, refresh } = useSnapshot();
  const [editing, setEditing] = useState<ServerView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [testing, setTesting] = useState<{ server: ServerView; tool: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const goToPanel = useCallback(() => navigate.toPluginPanel("mcp-hub"), [navigate]);

  if (subPath.startsWith("oauth/callback")) {
    return <OAuthCallback subPath={subPath} onDone={goToPanel} />;
  }

  const servers = snapshot?.servers ?? [];
  const tools: ToolView[] = snapshot?.tools ?? [];
  const problems: ToolProblem[] = snapshot?.problems ?? [];
  const broken = servers.filter(
    (server) => server.enabled && (server.state === "needs-auth" || server.state === "failed"),
  );

  async function toggle(server: ServerView, enabled: boolean): Promise<void> {
    setBusy(server.id);
    try {
      await rpc.serverEnabled({ id: server.id, enabled });
      await refresh();
    } catch (caught) {
      setBusy(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const openServer = servers.find((server) => server.id === openId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="min-w-0 flex-1 text-sm font-semibold">MCP servers</h1>
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
        {error ? (
          <p className="mb-3 text-xs text-destructive">{error}</p>
        ) : null}
        {broken.length > 0 ? (
          <p className="mb-3 text-xs text-amber-600">
            {broken.map((server) => server.name).join(", ")} need
            {broken.length === 1 ? "s" : ""} a sign-in. Open the server and press Connect.
          </p>
        ) : null}
        {snapshot?.truncated ? (
          <p className="mb-3 text-xs text-amber-600">
            More than 256 tools are on. Turn some off in a server's drawer.
          </p>
        ) : null}

        {loading && !snapshot ? <p className="text-xs text-muted-foreground">Loading…</p> : null}

        {!loading && servers.length === 0 ? (
          <div className="mt-10 space-y-2 text-center">
            <p className="text-sm">No MCP servers yet.</p>
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
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-muted/40"
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
              <Switch
                checked={server.enabled}
                disabled={busy === server.id}
                onCheckedChange={(checked) => void toggle(server, checked)}
                aria-label={`${server.name} on`}
              />
            </div>
          ))}
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
