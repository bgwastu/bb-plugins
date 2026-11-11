// The MCP connections panel: the servers this plugin knows about, and which
// of their tools each project may use.
//
// Every read goes through the plugin's own RPC contract, so this file never
// learns anything about MCP that the backend did not choose to publish.
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MAX_SELECTED_TOOLS } from "../server/configure.js";
import {
  isHeaderAuthenticated,
  MCP_CHANGED,
  OAUTH_CALLBACK_SUBPATH,
  oauthRedirectUriFor,
  type McpProjectDto,
  type McpRpcContract,
  type McpToolDetailsDto,
  type McpServerAddInput,
  type McpServerDto,
  type McpServerKind,
  type McpToolDto,
} from "../../contract.js";

/**
 * The connection types the add form offers, in the order it offers them.
 *
 * A transport enum is the wrong question to put in front of a user: "stdio"
 * and "http" describe how BB speaks to a server, and what someone adding one
 * actually knows is what kind of thing they are adding. A gateway is http like
 * any other remote server - nothing downstream branches on this - but it is a
 * different answer, so it is a different choice.
 */
const KINDS: ReadonlyArray<{
  value: McpServerKind;
  label: string;
  hint: string;
  namePlaceholder: string;
  urlPlaceholder: string;
}> = [
  {
    value: "remote",
    label: "Remote MCP server",
    hint: "A hosted MCP endpoint. Sign in with OAuth, or send a static token as a header.",
    namePlaceholder: "Notion",
    urlPlaceholder: "https://mcp.notion.com/mcp",
  },
  {
    value: "local",
    label: "Local command",
    hint: "A program BB runs on this machine and talks to over stdio.",
    namePlaceholder: "Filesystem",
    urlPlaceholder: "",
  },
  {
    value: "gateway",
    label: "Gateway (Executor)",
    hint: "One endpoint in front of many integrations. A few tools reach everything "
      + "connected there, so its tool count stays small and its descriptions change "
      + "as you add integrations.",
    namePlaceholder: "Executor",
    urlPlaceholder: "https://executor.example.com/mcp",
  },
];

/**
 * OAuth `state` values this tab has already exchanged.
 *
 * Module scope rather than a ref: the exchange consumes a single-use nonce, so
 * a second attempt fails by design, and StrictMode runs an effect twice on
 * purpose. Without this the honest second failure would be rendered as if the
 * connection had not worked.
 */
const exchangedStates = new Set<string>();

/**
 * The project picker's first entry, and the mode the panel opens in: the rows
 * edit each tool's global default rather than one project's override. A
 * `SelectItem` may not carry an empty value, and a project id can never be
 * this.
 */
const ALL_PROJECTS = "all";

/** The server filter's first entry. A server id can never be this. */
const ALL_SERVERS = "all";

/** `tools_set_default` rejects a longer list outright; see contract.ts. */
const MAX_DEFAULT_BATCH = 500;

/**
 * One project's answer for one tool. `inherit` deletes the row, so a tool
 * whose default flips later goes on following it.
 */
type BindingState = "inherit" | "on" | "off";

/**
 * The empty override map, shared. Built per call it would be a new value on
 * every pass of the load effect, and a new value re-renders every row in the
 * table to display exactly what was already there.
 */
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

interface TestResult {
  ok: boolean;
  toolCount: number;
  error: string | null;
  stderr: string[];
}

/**
 * Bumps a counter whenever the panel's data could have changed underneath it.
 *
 * Two sources, and both are needed. `mcp-changed` covers a mutation from
 * anywhere - this window, another window, or the OAuth callback route that
 * syncs a catalog with no panel involved. The reconnect transition covers the
 * gap the first one cannot: realtime signals are ephemeral and never replayed,
 * so everything published while the socket was down is simply lost, and a
 * panel that only listens sits there showing pre-outage state forever.
 */
function useChangeTick(): number {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => { setTick((value) => value + 1); }, []);
  useRealtime(MCP_CHANGED, bump);

  const connection = useRealtimeConnectionState();
  // The first connection arrives as connecting -> connected and is not a
  // reconnection: the initial fetch already covers it.
  const wasInterrupted = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") {
      wasInterrupted.current = true;
      return;
    }
    if (connection === "connected" && wasInterrupted.current) {
      wasInterrupted.current = false;
      bump();
    }
  }, [connection, bump]);

  return tick;
}

function describeTransport(server: McpServerDto): string {
  return server.transport === "stdio"
    ? [server.command ?? "", ...server.args].join(" ").trim()
    : server.url ?? "";
}

/**
 * A token estimate, rendered as an estimate. The `~` is not decoration: the
 * backend counts characters and divides, because no public tokeniser for
 * Claude exists to do better, and a bare number invites the user to trust a
 * digit that was never measured. Abbreviated only past a thousand, where the
 * exact figure has stopped meaning anything anyway.
 */
function describeTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

function describeStatus(server: McpServerDto, toolCount: number): string {
  if (server.transport === "stdio") return "Local process";
  // Ahead of every other answer: a recorded failure is the one fact about this
  // server worth reading, and a stale "Connected" over dead credentials is the
  // exact lie this panel spent four days telling.
  if (server.authError !== null) return "Needs reconnect";
  if (server.authStatus === "connected") return "Connected";
  if (server.authStatus === "needs-reconnect") return "Needs reconnect";
  // Before the fallback, or a server whose token is in a header it sends on
  // every request reads as "Not connected" while it is answering calls.
  if (isHeaderAuthenticated(server)) return "Header auth";
  // No grant and no header, yet its tools are registered: an open server.
  if (toolCount > 0) return "No sign-in needed";
  return "Not connected";
}

/**
 * What the OAuth return leg is doing, for the one render that shows it.
 *
 * `null` in the overwhelmingly common case: the panel is just the panel, and
 * only a browser that has come back from an authorization server has any of
 * this to say.
 */
interface CallbackState {
  ok: boolean;
  message: string;
}

export function ConnectionsPanel(props: { subPath?: string }): ReactElement {
  const rpc = useRpc<McpRpcContract>();
  const navigate = useBbNavigate();
  const tick = useChangeTick();

  // Held in a ref so the load effect can depend on the tick alone: the hook's
  // identity is the host's business, and a new object each render would turn
  // this into a fetch loop.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const [servers, setServers] = useState<McpServerDto[] | null>(null);
  const [tools, setTools] = useState<McpToolDto[]>([]);
  const [projects, setProjects] = useState<McpProjectDto[]>([]);
  const [projectId, setProjectId] = useState(ALL_PROJECTS);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(NO_OVERRIDES);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [callback, setCallback] = useState<CallbackState | null>(null);

  /**
   * The callback URL an OAuth client has to be told about, for THIS browser.
   *
   * Composed from the origin the panel is being served from rather than
   * reported by the backend, because the backend cannot know it: BB answers on
   * loopback, on a tailnet name and through a Connect tunnel at the same time,
   * and only the browser doing the authorizing knows which of them it is on.
   */
  const redirectUri = typeof window === "undefined"
    ? ""
    : oauthRedirectUriFor(window.location.origin);

  const [localTick, setLocalTick] = useState(0);
  const refetch = useCallback(() => { setLocalTick((value) => value + 1); }, []);

  /**
   * Drops a server's last Test result.
   *
   * A test result describes one connection attempt at one moment. Left in
   * place it outlives the thing it described: a stale "Could not connect" and
   * its stderr tail would survive a sync that just proved the server works,
   * and would come back verbatim if a server with the same derived id were
   * added again later.
   */
  const clearTest = useCallback((serverId: string) => {
    setTests((current) => {
      if (!(serverId in current)) return current;
      const next = { ...current };
      delete next[serverId];
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [serverList, toolList] = await Promise.all([
          rpcRef.current.call("servers_list", null),
          rpcRef.current.call("tools_list", {}),
        ]);
        if (cancelled) return;
        setServers(serverList.servers);
        setTools(toolList.tools);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
      // Separately, and deliberately not fatal: the other two read this
      // plugin's own database, while this one is a round trip to the BB
      // server. A project list that does not answer must cost the user their
      // binding editor, not the whole panel.
      try {
        const projectList = await rpcRef.current.call("projects_list", null);
        if (cancelled) return;
        setProjects(projectList.projects);
        // The personal project is deliberately not selected here any more.
        // Landing inside a project makes the first click an override, and an
        // override is the one answer that stops following the default - so
        // the convenience would cost the user the setting that reaches every
        // other project, including the ones they have not created yet.
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => { cancelled = true; };
  }, [tick, localTick]);

  /**
   * Completes an authorization that redirected back into this panel.
   *
   * The redirect lands here, on an ordinary app URL, rather than on the
   * plugin's public HTTP route - which is what makes it work on an origin that
   * sits behind a login, where that route answers 401 and the authorization
   * code is lost. The code is exchanged over the panel's own authenticated
   * RPC, and the URL is scrubbed afterwards so a reload cannot replay it.
   */
  useEffect(() => {
    if (props.subPath !== OAUTH_CALLBACK_SUBPATH) return;
    const params = new URLSearchParams(window.location.search);
    // Nothing to read means this pass is not the one carrying the answer: the
    // effect runs again after the URL has been scrubbed (and StrictMode runs
    // it twice on purpose), and treating an empty query as a malformed
    // callback would replace the real message with "no authorization code".
    if ([...params.keys()].length === 0) return;
    const clean = (): void => { navigate.toPluginPanel("mcp-hub", { replace: true }); };

    const failure = params.get("error");
    if (failure !== null) {
      setCallback({
        ok: false,
        message: `The service reported "${params.get("error_description") ?? failure}".`,
      });
      clean();
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (code === null || state === null) {
      setCallback({ ok: false, message: "That callback carried no authorization code." });
      clean();
      return;
    }
    if (exchangedStates.has(state)) return;
    exchangedStates.add(state);
    void (async () => {
      try {
        const result = await rpcRef.current.call("oauth_complete", { code, state });
        setCallback({ ok: true, message: `Connected ${result.displayName}.` });
      } catch (cause) {
        setCallback({ ok: false, message: String(cause) });
      }
      clean();
      refetch();
    })();
  }, [props.subPath, navigate, refetch]);

  useEffect(() => {
    if (projectId === ALL_PROJECTS) {
      setOverrides(NO_OVERRIDES);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpcRef.current.call("bindings_list", { projectId });
        if (!cancelled) {
          setOverrides(new Map(result.overrides.map(
            (override) => [override.registeredName, override.enabled] as const,
          )));
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, tick, localTick]);

  /**
   * Runs one mutation and refetches. The backend publishes `mcp-changed` too,
   * but that signal is a courtesy to other windows: this panel must not be
   * left showing stale rows just because a socket was briefly down.
   */
  const mutate = useCallback(async (run: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await run();
      setError(null);
      refetch();
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refetch]);

  const onConnect = (server: McpServerDto): void => {
    setCallback(null);
    void mutate(async () => {
      const { authorizeUrl } = await rpcRef.current.call("servers_connect", {
        id: server.id,
        // The host this browser is on, so the authorization server sends it
        // back somewhere it can actually reach.
        redirectOrigin: window.location.origin,
      });
      // `null`: the server answered without credentials, so there is no sign-in
      // to follow and its tools are already in the list.
      if (authorizeUrl === null) {
        setCallback({ ok: true, message: `Connected ${server.displayName}. No sign-in needed.` });
        return;
      }
      navigate.openUrl(authorizeUrl);
    });
  };

  const onTest = (server: McpServerDto): void => {
    void mutate(async () => {
      const result = await rpcRef.current.call("servers_test", { id: server.id });
      setTests((current) => ({ ...current, [server.id]: result }));
    });
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex h-8 items-center gap-2">
          <h1 className="text-sm font-medium text-foreground">MCP servers</h1>
          <span className="text-xs text-muted-foreground">
            {servers === null ? "Loading" : `${servers.length}`}
          </span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => { setAdding((value) => !value); }}
          >
            {adding ? "Cancel" : "Add server"}
          </Button>
        </div>

        {adding ? (
          <AddServerForm
            busy={busy}
            redirectUri={redirectUri}
            onSubmit={async (input) => {
              // Kept open on failure: the error is above the form, and
              // closing it would throw away what the user typed.
              if (await mutate(() => rpcRef.current.call("servers_add", input))) {
                setAdding(false);
              }
            }}
          />
        ) : null}

        {error === null ? null : (
          <p className="mt-3 rounded-md border border-border bg-card p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {callback === null ? null : (
          <p
            className={`mt-3 rounded-md border p-2 text-xs ${callback.ok
              ? "border-border bg-card text-muted-foreground"
              : "border-destructive/40 bg-destructive/5 text-destructive"}`}
          >
            {callback.message}
          </p>
        )}

        <NeedsAttention
          servers={(servers ?? []).filter((server) => server.authError !== null)}
          busy={busy}
          onConnect={onConnect}
        />

        <DriftNotice
          count={tools.filter((tool) => tool.driftedFromRegistration).length}
          busy={busy}
          onReload={() => mutate(() => rpcRef.current.call("plugin_reload", null))}
        />

        <div className="mt-3 space-y-2">
          {servers === null ? null : servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No MCP servers yet. Add one to make its tools available to your threads.
            </p>
          ) : servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              busy={busy}
              redirectUri={redirectUri}
              toolCount={tools.filter((tool) => tool.serverId === server.id && !tool.stale).length}
              test={tests[server.id] ?? null}
              onSync={async () => {
                const ok = await mutate(
                  () => rpcRef.current.call("catalog_sync", { serverId: server.id }),
                );
                if (ok) clearTest(server.id);
                return ok;
              }}
              onConnect={() => { onConnect(server); }}
              onTest={() => { onTest(server); }}
              onSaveOAuthClient={(client) => mutate(
                () => rpcRef.current.call("servers_set_oauth_client", {
                  id: server.id, ...client,
                }),
              )}
              onSaveHeaders={(headers) => mutate(
                () => rpcRef.current.call("servers_set_headers", { id: server.id, headers }),
              )}
              onRemove={async () => {
                const ok = await mutate(
                  () => rpcRef.current.call("servers_remove", { id: server.id }),
                );
                if (ok) clearTest(server.id);
                return ok;
              }}
            />
          ))}
        </div>

        <ToolTable
          tools={tools}
          servers={servers ?? []}
          alwaysAskServers={new Set(
            (servers ?? []).filter((entry) => entry.alwaysAsk).map((entry) => entry.id),
          )}
          projects={projects}
          projectId={projectId}
          overrides={overrides}
          busy={busy}
          onProjectChange={setProjectId}
          onBind={(registeredName, state) => mutate(
            () => rpcRef.current.call("binding_set", { projectId, registeredName, state }),
          )}
          onDefault={(registeredNames, defaultEnabled) => mutate(
            () => rpcRef.current.call("tools_set_default", { registeredNames, defaultEnabled }),
          )}
          onAsk={(tool, ask) => mutate(
            () => rpcRef.current.call("tool_set_ask", {
              serverId: tool.serverId, upstreamName: tool.upstreamName, ask,
            }),
          )}
        />
      </div>
    </div>
  );
}

/**
 * The servers whose credentials have stopped working, said loudly and once.
 *
 * Above the list rather than only on the row, because the failure mode this
 * exists for is nobody looking: a grant an authorization server ended
 * overnight left this plugin answering 401 every seventeen minutes for four
 * days, with the reason in a log file and the panel showing a word in grey.
 * The reason is quoted in full - it is the part that says whether reconnecting
 * will help or whether a setting has to change first.
 */
function NeedsAttention(props: {
  servers: McpServerDto[];
  busy: boolean;
  onConnect(server: McpServerDto): void;
}): ReactElement | null {
  if (props.servers.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      {props.servers.map((server) => (
        <div key={server.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-destructive">
              {server.displayName} needs reconnecting
            </span>
            <Button
              size="sm"
              className="ml-auto"
              disabled={props.busy}
              onClick={() => { props.onConnect(server); }}
            >
              Reconnect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{server.authError?.message}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Says that tools have changed underneath their registrations, and offers the
 * only thing that fixes it.
 *
 * `registerTool` has no update and no unregister, so a description that moved
 * after a name was claimed reaches nobody until every registration is rebuilt
 * - and a sync, the obvious move, cannot do it. Adding one integration to a
 * gateway moves nothing but one tool's description, so this is the normal way
 * a gateway's catalog changes rather than a rare event.
 *
 * Deliberately a button and not automatic: a reload cancels every tool-approval
 * prompt waiting on every thread, which is not something to do to someone who
 * did not ask.
 */
function DriftNotice(props: {
  count: number;
  busy: boolean;
  onReload(): Promise<boolean>;
}): ReactElement | null {
  const [requested, setRequested] = useState(false);
  if (props.count === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">
          {props.count} {props.count === 1 ? "tool has" : "tools have"} changed since BB
          registered {props.count === 1 ? "it" : "them"}
        </span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={props.busy || requested}
          onClick={() => {
            setRequested(true);
            void props.onReload();
          }}
        >
          {requested ? "Reloading" : "Reload plugin"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Threads are still being shown the previous descriptions and input
        schemas, and syncing cannot change that - a registered tool cannot be
        updated in place. Reloading re-registers all of them. It also cancels
        any tool-approval prompt currently waiting on any thread.
      </p>
    </div>
  );
}

/**
 * Turns a `KEY=value` per line textarea into the record the contract wants.
 *
 * Split on the FIRST `=` only: a value is very often a URL or a token with an
 * `=` of its own, and splitting on every one would truncate it silently. Blank
 * lines, `#` comments and a line with no `=` are dropped rather than sent as
 * an empty key.
 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

/**
 * Turns a `Name: value` per line textarea into the header map.
 *
 * Split on the FIRST `:`, for the same reason `parseEnv` splits on the first
 * `=`: a value is very often a URL or a token containing one. The backend
 * rejects a malformed name or a value with a newline in it, so nothing is
 * validated here beyond dropping lines that carry no header at all.
 */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    headers[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return headers;
}

/** The inverse, for pre-filling the editor with what is already stored. */
export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
}

/**
 * A collapsed group of fields the common case never touches.
 *
 * The add form used to put headers, working directories and OAuth client
 * credentials at the same level as the server's name, which made every server
 * look like it needed all of them. Everything in here is real and reachable;
 * none of it is in the way.
 */
function Advanced(props: { children: ReactElement | ReactElement[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2"
        onClick={() => { setOpen((value) => !value); }}
      >
        {open ? "Hide advanced" : "Advanced"}
      </Button>
      {open ? <div className="space-y-3">{props.children}</div> : null}
    </div>
  );
}

function AddServerForm(
  props: {
    busy: boolean;
    redirectUri: string;
    onSubmit(input: McpServerAddInput): Promise<void>;
  },
): ReactElement {
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<McpServerKind>("remote");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [cwd, setCwd] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("");
  const preset = KINDS.find((entry) => entry.value === kind) ?? KINDS[0];

  const submit = (): void => {
    // Built key by key rather than with `?? undefined`: the RPC boundary is
    // strict JSON, and a key whose value is `undefined` is not the same thing
    // as an absent key once it has been through `JSON.stringify`.
    const input: McpServerAddInput = { displayName: displayName.trim(), kind };
    if (kind === "local") {
      input.command = command.trim();
      const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length > 0) input.args = parts;
      const parsed = parseEnv(env);
      if (Object.keys(parsed).length > 0) input.env = parsed;
      const workingDirectory = cwd.trim();
      if (workingDirectory !== "") input.cwd = workingDirectory;
    } else {
      input.url = url.trim();
      const parsedHeaders = parseHeaders(headers);
      if (Object.keys(parsedHeaders).length > 0) input.headers = parsedHeaders;
      // Sent at add time so a server needing a client the user made by hand is
      // one form rather than add-then-edit. Empty stays absent: the backend
      // reads a missing client id as "try dynamic registration".
      if (clientId.trim() !== "") input.oauthClientId = clientId.trim();
      if (clientSecret !== "") input.oauthClientSecret = clientSecret;
      if (scopes.trim() !== "") input.oauthScopes = scopes.trim();
    }
    void props.onSubmit(input);
  };

  return (
    <form
      className="mt-3 w-full space-y-3 rounded-md border border-border bg-card p-3"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="mcp-kind">Connection type</Label>
        <Select
          value={kind}
          onValueChange={(value) => { setKind(value as McpServerKind); }}
        >
          <SelectTrigger id="mcp-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{preset.hint}</p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={displayName}
          placeholder={preset.namePlaceholder}
          onChange={(event) => { setDisplayName(event.target.value); }}
        />
        <p className="text-xs text-muted-foreground">
          The server id is derived from this name, so pick something short.
        </p>
      </div>

      {kind === "local" ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              value={command}
              placeholder="npx"
              onChange={(event) => { setCommand(event.target.value); }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">Arguments</Label>
            <Input
              id="mcp-args"
              value={args}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              onChange={(event) => { setArgs(event.target.value); }}
            />
            <p className="text-xs text-muted-foreground">
              Separated by spaces. Quoting is not supported yet.
            </p>
          </div>
          <Advanced>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-env">Environment</Label>
              <Textarea
                id="mcp-env"
                value={env}
                rows={3}
                placeholder={"VL_INSTANCE_ENTRYPOINT=http://localhost:9428\nVM_INSTANCE_BEARER_TOKEN=..."}
                onChange={(event) => { setEnv(event.target.value); }}
              />
              <p className="text-xs text-muted-foreground">
                One KEY=value per line. Most container-based servers take their
                whole configuration this way.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-cwd">Working directory</Label>
              <Input
                id="mcp-cwd"
                value={cwd}
                placeholder="/Users/you/project"
                onChange={(event) => { setCwd(event.target.value); }}
              />
            </div>
          </Advanced>
        </>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={url}
              placeholder={preset.urlPlaceholder}
              onChange={(event) => { setUrl(event.target.value); }}
            />
            <p className="text-xs text-muted-foreground">
              Save it, then press Connect to sign in. Most servers register
              themselves, so there is usually nothing else to fill in.
            </p>
          </div>
          <Advanced>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-headers">Headers</Label>
              <Textarea
                id="mcp-headers"
                value={headers}
                rows={2}
                placeholder={"Authorization: Bearer s3cret\nX-Api-Key: ..."}
                onChange={(event) => { setHeaders(event.target.value); }}
              />
              <p className="text-xs text-muted-foreground">
                One Name: value per line. For a server that authenticates with a
                static token instead of OAuth.
              </p>
            </div>
            <OAuthClientFields
              idPrefix="mcp-add"
              clientId={clientId}
              clientSecret={clientSecret}
              scopes={scopes}
              hasStoredSecret={false}
              redirectUri={props.redirectUri}
              registeredRedirectUri={null}
              onClientId={setClientId}
              onClientSecret={setClientSecret}
              onScopes={setScopes}
            />
          </Advanced>
        </>
      )}

      <Button type="submit" size="sm" disabled={props.busy}>Save</Button>
    </form>
  );
}

/**
 * The OAuth client a user created by hand, and the redirect URI it has to be
 * told about.
 *
 * Shared by the add form and the per-server settings so the two cannot drift:
 * the redirect URI in particular is compared byte for byte by an authorization
 * server, and a panel that showed two different ones would be a panel that
 * teaches the user to register the wrong one half the time.
 */
function OAuthClientFields(props: {
  idPrefix: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  hasStoredSecret: boolean;
  /** What this browser would use. */
  redirectUri: string;
  /** What the stored client was actually registered with, if any. */
  registeredRedirectUri: string | null;
  onClientId(value: string): void;
  onClientSecret(value: string): void;
  onScopes(value: string): void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const mismatched = props.registeredRedirectUri !== null
    && props.registeredRedirectUri !== props.redirectUri;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        Only for a server that does not register clients automatically. Create
        the OAuth client in that service (a GCP project, a Slack app) and give
        it the redirect URI below.
      </p>

      <div className="grid gap-1.5">
        <Label htmlFor={`${props.idPrefix}-oauth-client-id`}>OAuth client id</Label>
        <Input
          id={`${props.idPrefix}-oauth-client-id`}
          value={props.clientId}
          placeholder="1234567890-abc.apps.googleusercontent.com"
          onChange={(event) => { props.onClientId(event.target.value); }}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${props.idPrefix}-oauth-client-secret`}>OAuth client secret</Label>
        <Input
          id={`${props.idPrefix}-oauth-client-secret`}
          type="password"
          value={props.clientSecret}
          placeholder={props.hasStoredSecret
            ? "A secret is stored; leave empty to keep it"
            : "GOCSPX-..."}
          onChange={(event) => { props.onClientSecret(event.target.value); }}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${props.idPrefix}-oauth-scopes`}>OAuth scopes</Label>
        <Input
          id={`${props.idPrefix}-oauth-scopes`}
          value={props.scopes}
          placeholder="channels:read chat:write"
          onChange={(event) => { props.onScopes(event.target.value); }}
        />
        <p className="text-xs text-muted-foreground">
          Separated by spaces or commas. A server that registers its own client
          can still need these.
        </p>
      </div>

      <div className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">
          Add this to the client&apos;s authorized redirect URIs:
        </span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-foreground">
            {props.redirectUri}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              // Optional-chained: a panel served over a plain-http origin has
              // no clipboard API, and the URL is on screen to select by hand
              // either way.
              void navigator.clipboard?.writeText(props.redirectUri);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          It follows the address you are reading this on, so BB is reachable at
          whatever host you use. Connecting from a different one registers a
          different URI.
        </p>
        {mismatched ? (
          <p className="text-xs text-destructive">
            This server was last connected as{" "}
            <code className="font-mono">{props.registeredRedirectUri}</code>.
            Connecting from here will register the URI above instead - automatic
            for a server that registers its own clients, but a client you made
            by hand has to list both.
          </p>
        ) : null}
      </div>
    </>
  );
}

function ServerRow(props: {
  server: McpServerDto;
  toolCount: number;
  test: TestResult | null;
  busy: boolean;
  /** The callback URL this server's OAuth client has to be told about. */
  redirectUri: string;
  onSync(): Promise<boolean>;
  onConnect(): void;
  onTest(): void;
  onSaveOAuthClient(client: {
    clientId: string | null; clientSecret: string | null; scopes: string | null;
  }): Promise<boolean>;
  onSaveHeaders(headers: Record<string, string>): Promise<boolean>;
  onRemove(): Promise<boolean>;
}): ReactElement {
  const { server, test } = props;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const remote = server.transport === "http";
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{server.displayName}</span>
        <span
          className={`text-xs ${server.authError === null
            ? "text-muted-foreground"
            : "text-destructive"}`}
        >
          {describeStatus(server, props.toolCount)}
        </span>
        <span className="text-xs text-muted-foreground">
          {props.toolCount} {props.toolCount === 1 ? "tool" : "tools"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {/* One primary action per row. Everything else - headers, the OAuth
              client, syncing, removing - lives behind Settings, because a row
              carrying five buttons made the destructive one as prominent as
              the one the user came for. */}
          {remote ? (
            // Offering Connect to a header-authenticated server is offering an
            // error: the RPC refuses it, and nothing about a typed-in token is
            // fixed by OAuth.
            isHeaderAuthenticated(server) ? null : (
              <Button size="sm" disabled={props.busy} onClick={props.onConnect}>
                {server.authStatus === "disconnected" ? "Connect" : "Reconnect"}
              </Button>
            )
          ) : (
            <Button size="sm" disabled={props.busy} onClick={props.onTest}>
              Test
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSettingsOpen(true); }}
          >
            Settings
          </Button>
        </div>
      </div>

      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
        {describeTransport(server)}
      </p>

      {server.authError === null ? null : (
        <p className="mt-2 text-xs text-destructive">{server.authError.message}</p>
      )}

      {/*
        Mounted only while it is open: `DialogContent` reads the viewport to
        decide between a dialog and a drawer, which is work no closed row
        should be doing once per server per render.
      */}
      {settingsOpen ? (
        <ServerSettings
          server={server}
          busy={props.busy}
          redirectUri={props.redirectUri}
          onClose={() => { setSettingsOpen(false); }}
          onSync={props.onSync}
          onSaveHeaders={props.onSaveHeaders}
          onSaveOAuthClient={props.onSaveOAuthClient}
          onRemove={props.onRemove}
        />
      ) : null}

      {test === null ? null : (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">
            {test.ok
              ? `Connected. ${test.toolCount} tools reported.`
              : `Could not connect. ${test.error ?? ""}`}
          </p>
          {/*
            The reason this panel has a Test button at all. The BB server
            resolves no login-shell PATH, so an npx- or docker-based server
            dies with an opaque "Connection closed" everywhere else; its own
            stderr is the only place the real cause is written down.
          */}
          {test.stderr.length === 0 ? null : (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 text-xs text-foreground">
              {test.stderr.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Everything about one server that is not its primary action.
 *
 * A dialog rather than two inline forms and a red button: these are all things
 * a user does once, or once a year, and having them permanently open in the
 * list made a configured server look like an unfinished one.
 */
function ServerSettings(props: {
  server: McpServerDto;
  busy: boolean;
  redirectUri: string;
  onClose(): void;
  onSync(): Promise<boolean>;
  onSaveHeaders(headers: Record<string, string>): Promise<boolean>;
  onSaveOAuthClient(client: {
    clientId: string | null; clientSecret: string | null; scopes: string | null;
  }): Promise<boolean>;
  onRemove(): Promise<boolean>;
}): ReactElement {
  const { server } = props;
  const [headers, setHeaders] = useState(() => formatHeaders(server.headers));
  const [clientId, setClientId] = useState(server.oauthClientId ?? "");
  // Starts empty even when one is stored: the DTO never carries the secret,
  // so there is nothing to pre-fill with and an empty box means "unchanged".
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(server.oauthScopes ?? "");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const remote = server.transport === "http";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{server.displayName}</DialogTitle>
          <DialogDescription className="font-mono">
            {describeTransport(server)}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={props.busy}
              onClick={() => { void props.onSync(); }}
            >
              Sync tools
            </Button>
            <span className="text-xs text-muted-foreground">
              Re-reads the server&apos;s tool list and registers anything new.
            </span>
          </div>

          {remote ? (
            <>
              <form
                className="space-y-3 rounded-md border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void props.onSaveHeaders(parseHeaders(headers));
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor={`mcp-headers-${server.id}`}>Headers</Label>
                  <Textarea
                    id={`mcp-headers-${server.id}`}
                    value={headers}
                    rows={3}
                    placeholder={"Authorization: Bearer s3cret\nX-Api-Key: ..."}
                    onChange={(event) => { setHeaders(event.target.value); }}
                  />
                  <p className="text-xs text-muted-foreground">
                    One Name: value per line, sent on every request to this
                    server. Saving replaces the whole set, so deleting a line
                    stops it being sent. An Authorization header here is
                    overridden by the OAuth token whenever this server is
                    connected.
                  </p>
                </div>
                <Button type="submit" size="sm" disabled={props.busy}>Save headers</Button>
              </form>

              <form
                className="space-y-3 rounded-md border border-border bg-background p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void props.onSaveOAuthClient({
                    clientId: clientId.trim(),
                    // Empty means "leave the stored secret alone", which is the
                    // only thing it can mean: the panel is never told the
                    // secret, so it cannot send one back, and treating empty as
                    // "clear" would wipe the secret every time the client id
                    // was corrected.
                    clientSecret: clientSecret === "" ? null : clientSecret,
                    scopes: scopes.trim(),
                  });
                }}
              >
                <OAuthClientFields
                  idPrefix={`mcp-${server.id}`}
                  clientId={clientId}
                  clientSecret={clientSecret}
                  scopes={scopes}
                  hasStoredSecret={server.hasOauthClientSecret}
                  redirectUri={props.redirectUri}
                  registeredRedirectUri={server.registeredRedirectUri}
                  onClientId={setClientId}
                  onClientSecret={setClientSecret}
                  onScopes={setScopes}
                />
                <p className="text-xs text-muted-foreground">
                  Saving disconnects this server: a token issued to a different
                  client, or for different scopes, is not one these credentials
                  can go on using. Connect again afterwards.
                </p>
                <Button type="submit" size="sm" disabled={props.busy}>
                  Save OAuth client
                </Button>
              </form>
            </>
          ) : null}

          <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            {confirmingRemove ? (
              <>
                <p className="text-xs text-muted-foreground">
                  This also deletes its tool catalog, every project binding that
                  names one of its tools, and any stored credentials - the OAuth
                  access and refresh tokens it was connected with. Nothing here
                  can undo it: you would have to add the server again, authorize
                  it again, and re-enable each tool by hand.
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setConfirmingRemove(false); }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => {
                      props.onClose();
                      void props.onRemove();
                    }}
                  >
                    Remove server
                  </Button>
                </div>
              </>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                disabled={props.busy}
                onClick={() => { setConfirmingRemove(true); }}
              >
                Remove {server.displayName}
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={props.onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToolDetails(props: { registeredName: string }): ReactElement {
  const rpc = useRpc<McpRpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  const [details, setDetails] = useState<McpToolDetailsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawShown, setRawShown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    void (async () => {
      try {
        const result = await rpcRef.current.call(
          "tool_details", { registeredName: props.registeredName },
        );
        if (!cancelled) setDetails(result.tool);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();
    return () => { cancelled = true; };
  }, [props.registeredName]);

  if (error !== null) {
    return <p className="mt-2 text-xs text-destructive">{error}</p>;
  }
  if (details === null) {
    return <p className="mt-2 text-xs text-muted-foreground">Loading details...</p>;
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border bg-background p-3">
      <div>
        <p className="text-xs font-medium text-foreground">Description</p>
        {/*
          Preserved as written: an MCP description is often several paragraphs
          of instructions to the model, and collapsing its line breaks turns
          the thing the user opened the row to read into a wall.
        */}
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {details.description === "" ? "No description." : details.description}
        </p>
      </div>

      <div>
        <p className="text-xs font-medium text-foreground">Parameters</p>
        {details.parameters.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            This tool takes no arguments.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {details.parameters.map((parameter) => (
              <li key={parameter.name} className="text-xs">
                <span className="font-mono text-foreground">{parameter.name}</span>
                <span className="text-muted-foreground"> {parameter.type}</span>
                {parameter.required ? (
                  <span className="text-muted-foreground"> - required</span>
                ) : null}
                {parameter.description === null ? null : (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {parameter.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The list above is the readable answer; this is the exact one, for a
          schema whose shape a flat list cannot express. */}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { setRawShown((shown) => !shown); }}
        >
          {rawShown ? "Hide raw schema" : "Show raw schema"}
        </Button>
        {rawShown ? (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2 font-mono text-xs text-foreground">
            {details.inputSchema}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function ToolTable(props: {
  tools: McpToolDto[];
  /** Every configured server, so the filter can offer names and not ids. */
  servers: McpServerDto[];
  /**
   * Servers whose tools always prompt (design section 12.1). The switch is
   * shown disabled rather than hidden: a user who cannot find it assumes a
   * bug, and a user who sees it greyed out with the reason underneath
   * understands the trade being made for them.
   */
  alwaysAskServers: ReadonlySet<string>;
  projects: McpProjectDto[];
  projectId: string;
  /** The chosen project's overrides. An absent name inherits the default. */
  overrides: ReadonlyMap<string, boolean>;
  busy: boolean;
  onProjectChange(projectId: string): void;
  onBind(registeredName: string, state: BindingState): Promise<boolean>;
  onDefault(registeredNames: string[], defaultEnabled: boolean): Promise<boolean>;
  onAsk(tool: McpToolDto, ask: boolean): Promise<boolean>;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [server, setServer] = useState(ALL_SERVERS);
  /*
    One row open at a time: each expansion is a call of its own, and a list
    where every row can be open at once is a list where a curious user fetches
    the whole catalog's schemas one click at a time.
  */
  const [expanded, setExpanded] = useState<string | null>(null);

  // Computed, never repaired in an effect. A removed server - or one gone
  // from a realtime refetch - would otherwise leave one render filtering on
  // an id nothing matches, which reads as "every tool disappeared".
  const serverFilter = props.servers.some((entry) => entry.id === server)
    ? server
    : ALL_SERVERS;

  const defaultsMode = props.projectId === ALL_PROJECTS;
  const needle = query.trim().toLowerCase();
  const shown = props.tools.filter((tool) => {
    if (serverFilter !== ALL_SERVERS && tool.serverId !== serverFilter) return false;
    if (needle === "") return true;
    return tool.registeredName.toLowerCase().includes(needle)
      || tool.upstreamName.toLowerCase().includes(needle)
      || tool.description.toLowerCase().includes(needle);
  });
  const shownNames = shown.map((tool) => tool.registeredName);

  // The backend's own rule, run here: defaults, minus what this project
  // forced off, plus what it forced on. A stale row is never registered with
  // the host, so it can be neither.
  const selected = new Set<string>();
  let selectedTokens = 0;
  for (const tool of props.tools) {
    if (tool.stale) continue;
    const override = props.overrides.get(tool.registeredName);
    if (override ?? tool.defaultEnabled) {
      selected.add(tool.registeredName);
      selectedTokens += tool.estimatedTokens;
    }
  }

  const clearFilter = (): void => {
    setQuery("");
    setServer(ALL_SERVERS);
  };

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-medium text-foreground">Tools</h2>
        {/*
          The cap truncates alphabetically and says nothing to the user, and a
          default-on tool counts against every project at once - so the count
          has to be legible before it starts silently dropping tools.
        */}
        <span className="text-xs text-muted-foreground">
          {selected.size} of {MAX_SELECTED_TOOLS} selected
        </span>
        {/*
          The count answers how many, which is the cheap half of the question.
          A tool is paid for in schema, every thread, before a word is typed -
          and 256 of them can be most of a context window, so the bill belongs
          next to the tally that says nothing about it.
        */}
        <span className="text-xs text-muted-foreground">
          {describeTokens(selectedTokens)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          aria-label="Search tools"
          value={query}
          placeholder="Search"
          onChange={(event) => { setQuery(event.target.value); }}
        />
        <div className="w-44">
          <Select value={serverFilter} onValueChange={setServer}>
            <SelectTrigger aria-label="Filter by server">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SERVERS}>All servers</SelectItem>
              {props.servers.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>{entry.displayName}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56">
          <Select value={props.projectId} onValueChange={props.onProjectChange}>
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects (defaults)</SelectItem>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.personal ? `${project.name} (personal)` : project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/*
        Against the server filter this is the per-server toggle, with no
        per-server grouping to build. Disabled rather than sliced past the
        batch limit: a partial toggle presented as a whole one is worse than
        one the user has to narrow first.
      */}
      {defaultsMode ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy || shownNames.length === 0
              || shownNames.length > MAX_DEFAULT_BATCH}
            onClick={() => { void props.onDefault(shownNames, true); }}
          >
            Enable all shown
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy || shownNames.length === 0
              || shownNames.length > MAX_DEFAULT_BATCH}
            onClick={() => { void props.onDefault(shownNames, false); }}
          >
            Disable all shown
          </Button>
        </div>
      ) : null}

      {props.tools.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No tools yet. Sync a server to read its catalog.
        </p>
      ) : shown.length === 0 ? (
        // Its own state, because the other one tells the user to sync a
        // server they have already synced - the catalog is full, the filter
        // is what emptied the list.
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">No tools match this filter.</p>
          <Button size="sm" variant="ghost" onClick={clearFilter}>Clear</Button>
        </div>
      ) : (
        <div className="mt-2 divide-y divide-border rounded-md border border-border bg-card">
          {shown.map((tool) => {
            const forced = props.alwaysAskServers.has(tool.serverId);
            const override = props.overrides.get(tool.registeredName);
            const isExpanded = expanded === tool.registeredName;
            return (
            <div key={tool.registeredName} className="flex items-start gap-3 p-3">
              {defaultsMode ? (
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Enable ${tool.registeredName} by default`}
                  checked={tool.defaultEnabled}
                  disabled={props.busy}
                  onCheckedChange={(value) => {
                    void props.onDefault([tool.registeredName], value === true);
                  }}
                />
              ) : (
                /*
                  One control rather than a state column plus a switch: the
                  first item carries the default, so "on because nobody said
                  otherwise" and "on because this project insisted" are told
                  apart without reading two things against each other.
                */
                <div className="w-32 shrink-0">
                  <Select
                    value={override === undefined ? "inherit" : override ? "on" : "off"}
                    disabled={props.busy}
                    onValueChange={(value) => {
                      void props.onBind(tool.registeredName, value as BindingState);
                    }}
                  >
                    <SelectTrigger aria-label={`${tool.registeredName} in this project`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">
                        {tool.defaultEnabled ? "Default (on)" : "Default (off)"}
                      </SelectItem>
                      <SelectItem value="on">Always on</SelectItem>
                      <SelectItem value="off">Off</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="min-w-0 flex-1">
                {/*
                  The name is the disclosure control: the row's one line of
                  description is a preview of something that is usually
                  paragraphs long, and the rest of it - and what the tool
                  takes - has to be reachable without leaving the panel.
                */}
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-1 text-left"
                  aria-expanded={isExpanded}
                  onClick={() => {
                    setExpanded(isExpanded ? null : tool.registeredName);
                  }}
                >
                  <Icon
                    name={isExpanded ? "ChevronDown" : "ChevronRight"}
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate font-mono text-xs text-foreground">
                    {tool.registeredName}
                    {tool.stale ? " (gone from the server)" : ""}
                    {tool.driftedFromRegistration ? " (reload to update)" : ""}
                  </span>
                </button>
                {isExpanded ? null : (
                  <p className="truncate text-xs text-muted-foreground">{tool.description}</p>
                )}
                {/* What a tool costs a thread is its schema, not its name. */}
                <p className="text-xs text-muted-foreground">
                  {describeTokens(tool.estimatedTokens)}
                  {tool.readOnly ? ", read-only" : ""}
                </p>
                {/* Syncing again is the obvious move and the one that cannot
                    work, so the row says what does. */}
                {tool.driftedFromRegistration ? (
                  <p className="text-xs text-muted-foreground">
                    This tool's description or inputs changed after BB
                    registered it. A registered tool cannot be updated in
                    place, so threads keep seeing the previous version until
                    the plugin is reloaded: <code>bb plugin reload mcp</code>.
                  </p>
                ) : null}
                {forced ? (
                  <p className="text-xs text-muted-foreground">
                    Always asks: reading an attacker-authored message from a
                    Google account is itself the attack this prompt exists for,
                    so a read-only marking does not switch it off.
                  </p>
                ) : null}
                {isExpanded ? <ToolDetails registeredName={tool.registeredName} /> : null}
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  aria-label={`Ask before running ${tool.registeredName}`}
                  checked={tool.ask}
                  disabled={props.busy || forced}
                  onCheckedChange={(value) => { void props.onAsk(tool, value === true); }}
                />
                Ask
              </label>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
