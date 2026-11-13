// The MCP button in the composer footer, and the one popup it opens.
//
// A switch per server, and nothing else. The switches are the same ones the
// management page shows - turning a server off turns it off everywhere - so
// there is no second kind of state to explain and no per-thread bookkeeping.
import { useState } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import type { ServerView } from "../../contract.js";
import { errorText, useSnapshot } from "./data.js";
import { useApi } from "./rpc.js";

export const MCP_POPUP_ID = "servers";

function enabledCount(servers: ServerView[]): number {
  return servers.filter((server) => server.enabled).length;
}

export function McpComposerAction() {
  const composer = useComposer();
  const { snapshot } = useSnapshot();
  const servers = snapshot?.servers ?? [];
  const on = enabledCount(servers);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 rounded-md px-2 text-xs"
      aria-label="Choose which MCP servers are on"
      onClick={() => composer.experimental_openPopup(MCP_POPUP_ID)}
    >
      <Icon name="ElectricPlugs" className="size-3.5" aria-hidden />
      <span>MCP</span>
      {servers.length > 0 ? (
        <span className={on === 0 ? "text-muted-foreground" : ""}>{on === 0 ? "off" : on}</span>
      ) : null}
    </Button>
  );
}

export function McpComposerPopup() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const rpc = useApi();
  const { snapshot, error } = useSnapshot();
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const servers = snapshot?.servers ?? [];
  const threadId = composer.scope.kind === "new-thread" ? null : composer.scope.threadId;

  async function toggle(server: ServerView, enabled: boolean): Promise<void> {
    setBusy(server.id);
    setFailure(null);
    setMessage(null);
    try {
      await rpc.serverEnabled({ id: server.id, enabled });
      setChanged(true);
    } catch (caught) {
      setFailure(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function restart(): Promise<void> {
    if (!threadId) return;
    setBusy("restart");
    setFailure(null);
    try {
      const result = await rpc.restartThread({ threadId, interrupt: false });
      setMessage(result.deferred ? "Restarts when this turn ends." : "Restarted.");
      setChanged(false);
    } catch (caught) {
      setFailure(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex w-[18rem] flex-col">
      <div className="min-h-0 flex-1 py-1">
        {!snapshot ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p> : null}
        {snapshot && servers.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No MCP servers yet.</p>
        ) : null}
        {servers.map((server) => (
          <label
            key={server.id}
            className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50"
            title={server.error ?? undefined}
          >
            <Switch
              checked={server.enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) => void toggle(server, checked)}
            />
            <span className="min-w-0 flex-1 truncate text-xs">{server.name}</span>
            {server.state === "needs-auth" ? (
              <span className="shrink-0 text-[10px] text-amber-600">sign in</span>
            ) : null}
          </label>
        ))}
      </div>

      <div className="space-y-1.5 border-t px-3 py-2">
        {message ? <p className="text-[11px] text-muted-foreground">{message}</p> : null}
        {failure ?? error ? <p className="text-[11px] text-destructive">{failure ?? error}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              composer.experimental_closePopup();
              navigate.toPluginPanel("mcp-hub");
            }}
          >
            Manage servers
          </button>
          {changed && threadId ? (
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy !== null}
              onClick={() => void restart()}
            >
              {busy === "restart" ? "Restarting…" : "Restart thread"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
