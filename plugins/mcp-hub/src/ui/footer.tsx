// The MCP button in the composer footer, and the popup it opens.
//
// This is the everyday surface: which servers and tools this conversation may
// use. Two layers underneath - this choice, and the switches on the management
// page - and only the entries someone actually moved in this popup are stored,
// so a tool added later still reaches a thread that never had an opinion.
import { useEffect, useMemo, useState } from "react";
import { useBbNavigate, useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Selection } from "../../contract.js";
import { errorText, useSelection, useSnapshot } from "./data.js";
import { useApi } from "./rpc.js";

export const MCP_POPUP_ID = "tools";

interface Draft {
  servers: Record<string, boolean>;
  tools: Record<string, boolean>;
}

interface Change {
  servers: Set<string>;
  tools: Set<string>;
}

/**
 * The composer's scope, reduced to what the popup needs.
 *
 * A queued-message composer edits a message, not a session, so it gets no
 * button at all (see the customization's `scopes`).
 */
function scopeOf(composer: ReturnType<typeof useComposer>): {
  threadId: string | undefined;
  projectId: string | undefined;
} {
  const scope = composer.scope;
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return { threadId: scope.threadId, projectId: undefined };
  }
  return { threadId: undefined, projectId: scope.projectId ?? undefined };
}

function summarise(selection: Selection | null): string {
  if (!selection) return "";
  const serversOn = selection.servers.filter((server) => server.enabled).length;
  if (serversOn === 0) return "Off";
  return `${selection.offered}`;
}

export function McpComposerAction() {
  const composer = useComposer();
  const { threadId, projectId } = scopeOf(composer);
  const { selection } = useSelection(threadId, projectId);
  const blocked = selection !== null && selection.servers.every((server) => !server.enabled);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={`h-7 gap-1.5 rounded-md px-2 text-xs ${blocked ? "text-muted-foreground" : ""}`}
      aria-label="Choose which MCP tools this conversation can use"
      onClick={() => composer.experimental_openPopup(MCP_POPUP_ID)}
    >
      <Icon name="ElectricPlugs" className="size-3.5" aria-hidden />
      <span>MCP</span>
      {selection && selection.offered > 0 ? (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{summarise(selection)}</span>
      ) : null}
    </Button>
  );
}

export function McpComposerPopup() {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const rpc = useApi();
  const { threadId, projectId } = scopeOf(composer);
  const { selection, refresh, error } = useSelection(threadId, projectId);
  const { snapshot } = useSnapshot();

  const [draft, setDraft] = useState<Draft>({ servers: {}, tools: {} });
  const [changed, setChanged] = useState<Change>({ servers: new Set(), tools: new Set() });
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Seed from what the backend resolved, then leave the draft alone: a
  // refetch arriving while someone is mid-click must not undo the click.
  useEffect(() => {
    if (!selection) return;
    setDraft({
      servers: Object.fromEntries(selection.servers.map((server) => [server.id, server.enabled])),
      tools: Object.fromEntries(
        selection.servers.flatMap((server) => server.tools.map((tool) => [tool.name, tool.enabled])),
      ),
    });
  }, [selection]);

  const globalServer = useMemo(
    () => new Map((snapshot?.servers ?? []).map((server) => [server.id, server.enabled])),
    [snapshot],
  );
  const globalTool = useMemo(
    () => new Map((snapshot?.tools ?? []).map((tool) => [tool.name, tool.enabled])),
    [snapshot],
  );

  function setServer(id: string, value: boolean): void {
    setDraft((current) => ({ ...current, servers: { ...current.servers, [id]: value } }));
    setChanged((current) => ({ ...current, servers: new Set(current.servers).add(id) }));
    setMessage(null);
  }

  function setTool(name: string, value: boolean): void {
    setDraft((current) => ({ ...current, tools: { ...current.tools, [name]: value } }));
    setChanged((current) => ({ ...current, tools: new Set(current.tools).add(name) }));
    setMessage(null);
  }

  async function save(interrupt: boolean): Promise<void> {
    setSaving(true);
    setFailure(null);
    setMessage(null);
    try {
      const servers: Record<string, boolean> = {};
      const clearedServers: string[] = [];
      for (const id of changed.servers) {
        const value = draft.servers[id];
        if (value === undefined) continue;
        // Matching the global switch is the absence of an opinion, not an
        // opinion that happens to agree, so the override is dropped.
        if (value === (globalServer.get(id) ?? true)) clearedServers.push(id);
        else servers[id] = value;
      }
      const tools: Record<string, boolean> = {};
      const clearedTools: string[] = [];
      for (const name of changed.tools) {
        const value = draft.tools[name];
        if (value === undefined) continue;
        if (value === (globalTool.get(name) ?? true)) clearedTools.push(name);
        else tools[name] = value;
      }

      const result = await rpc.selectionSet({
        ...(threadId ? { threadId } : {}),
        ...(projectId ? { projectId } : {}),
        servers,
        tools,
        clearedServers,
        clearedTools,
        apply: threadId !== undefined,
        interrupt,
      });
      setChanged({ servers: new Set(), tools: new Set() });
      await refresh();
      if (result.deferred) {
        setMessage("Saved. The new tools apply when this turn ends.");
      } else if (threadId) {
        setMessage("Saved. The session restarted.");
        composer.experimental_closePopup();
      } else {
        setMessage("Saved. New threads in this project start with this.");
        composer.experimental_closePopup();
      }
    } catch (caught) {
      setFailure(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  const dirty = changed.servers.size > 0 || changed.tools.size > 0;
  // A new-thread composer before a project is chosen has nowhere to store the
  // choice, and inventing a place would apply it to every project.
  const addressable = threadId !== undefined || projectId !== undefined;
  const needle = filter.trim().toLowerCase();

  return (
    <div className="flex max-h-[70vh] w-[22rem] flex-col sm:w-[24rem]">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">MCP tools</p>
          <p className="text-[11px] text-muted-foreground">
            {threadId ? "For this conversation" : "For new threads in this project"}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            composer.experimental_closePopup();
            navigate.toPluginPanel("mcp-hub");
          }}
        >
          Manage servers
        </button>
      </div>

      {selection && selection.servers.length > 3 ? (
        <div className="border-b px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter servers and tools"
            className="h-7 text-xs"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {!selection ? <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p> : null}
        {selection && selection.servers.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No MCP servers yet. Add one in the MCP settings.
          </p>
        ) : null}
        {selection?.servers.map((server) => {
          const serverMatches = needle.length === 0 || server.name.toLowerCase().includes(needle);
          const tools = server.tools.filter(
            (tool) =>
              needle.length === 0 ||
              serverMatches ||
              tool.label.toLowerCase().includes(needle) ||
              tool.name.toLowerCase().includes(needle),
          );
          if (!serverMatches && tools.length === 0) return null;
          const effective = draft.servers[server.id] ?? server.enabled;
          const open = expanded === server.id;
          return (
            <div key={server.id} className="rounded-md">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Switch
                  checked={effective && server.unavailable === null}
                  disabled={server.unavailable !== null}
                  onCheckedChange={(checked) => setServer(server.id, checked)}
                  title={server.unavailable ?? undefined}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setExpanded(open ? null : server.id)}
                >
                  <span className="block truncate text-xs">{server.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {server.unavailable ?? `${tools.length} tool${tools.length === 1 ? "" : "s"}`}
                  </span>
                </button>
                {tools.length > 0 ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
                ) : null}
              </div>
              {open ? (
                <div className="ml-3 space-y-0.5 border-l pl-2">
                  {tools.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50"
                    >
                      <Switch
                        checked={(draft.tools[tool.name] ?? tool.enabled) && effective}
                        disabled={!effective || server.unavailable !== null}
                        onCheckedChange={(checked) => setTool(tool.name, checked)}
                      />
                      <span className="min-w-0 flex-1 truncate text-[11px]" title={tool.name}>
                        {tool.label}
                      </span>
                      {tool.readOnly ? (
                        <span className="shrink-0 text-[9px] uppercase text-muted-foreground">read</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="space-y-1.5 border-t px-3 py-2">
        {selection?.truncated ? (
          <p className="text-[11px] text-amber-600">
            More than 256 tools are on; turn some off so the rest fit.
          </p>
        ) : null}
        {composer.isRunning ? (
          <p className="text-[11px] text-muted-foreground">
            Saving restarts this conversation after the current turn. Background shells and sub-agents
            running here will stop.
          </p>
        ) : null}
        {addressable ? null : (
          <p className="text-[11px] text-muted-foreground">
            Choose a project first; this choice is remembered for the project.
          </p>
        )}
        {message ? <p className="text-[11px] text-muted-foreground">{message}</p> : null}
        {failure ?? error ? <p className="text-[11px] text-destructive">{failure ?? error}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => {
              composer.experimental_closePopup();
              navigate.toPluginPanel("mcp-hub");
            }}
          >
            All settings
          </Button>
          <div className="flex items-center gap-1.5">
            {composer.isRunning && dirty ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={saving}
                onClick={() => void save(true)}
                aria-label="Restart now, interrupting the current turn"
              >
                Apply now
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={saving || !dirty || !addressable}
              onClick={() => void save(false)}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
