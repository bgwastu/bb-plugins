// Add or edit one server. The form asks what kind of thing is being added and
// reveals only the fields that kind needs; a transport enum is the wrong first
// question for anyone who is not already thinking in MCP wire terms.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import type { McpAuth, McpTransport, ServerInput, ServerView } from "../../contract.js";
import { currentOrigin, errorText } from "./data.js";
import { useApi } from "./rpc.js";

interface Pair {
  name: string;
  value: string;
}

function recordFrom(pairs: Pair[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    if (pair.name.trim().length === 0) continue;
    result[pair.name.trim()] = pair.value;
  }
  return result;
}

function PairEditor(props: {
  pairs: Pair[];
  onChange(pairs: Pair[]): void;
  namePlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  secret?: boolean;
}) {
  const { pairs, onChange } = props;
  return (
    <div className="space-y-1.5">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={pair.name}
            placeholder={props.namePlaceholder}
            className="h-8 font-mono text-xs"
            onChange={(event) => {
              const next = [...pairs];
              next[index] = { ...pair, name: event.target.value };
              onChange(next);
            }}
          />
          <Input
            value={pair.value}
            placeholder={props.valuePlaceholder}
            type={props.secret ? "password" : "text"}
            className="h-8 font-mono text-xs"
            onChange={(event) => {
              const next = [...pairs];
              next[index] = { ...pair, value: event.target.value };
              onChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label="Remove"
            onClick={() => onChange(pairs.filter((_, at) => at !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-1.5 text-xs text-muted-foreground"
        onClick={() => onChange([...pairs, { name: "", value: "" }])}
      >
        + {props.addLabel}
      </Button>
    </div>
  );
}

const AUTH_LABELS: Record<McpAuth, string> = {
  none: "No authentication",
  oauth: "Sign in with OAuth",
  bearer: "Bearer token",
  headers: "Custom headers",
};

export interface ServerFormProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The server being edited, or null to add a new one. */
  server: ServerView | null;
  onSaved(): void;
}

export function ServerFormDialog({ open, onOpenChange, server, onSaved }: ServerFormProps) {
  const rpc = useApi();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [auth, setAuth] = useState<McpAuth>("none");
  const [bearer, setBearer] = useState("");
  const [bearerTouched, setBearerTouched] = useState(false);
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [headersTouched, setHeadersTouched] = useState(false);
  const [env, setEnv] = useState<Pair[]>([]);
  const [envTouched, setEnvTouched] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clientSecretTouched, setClientSecretTouched] = useState(false);
  const [scopes, setScopes] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = server !== null;

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setTransport(server?.transport ?? "http");
    setUrl(server?.url ?? "");
    setCommand(server?.command ?? "");
    setArgs((server?.args ?? []).join("\n"));
    setCwd(server?.cwd ?? "");
    setAuth(server?.auth ?? "none");
    setBearer("");
    setBearerTouched(false);
    setHeaders([]);
    setHeadersTouched(false);
    setEnv([]);
    setEnvTouched(false);
    setClientId(server?.oauthClientId ?? "");
    setClientSecret("");
    setClientSecretTouched(false);
    setScopes(server?.oauthScopes ?? "");
    setAdvanced(false);
    setBusy(false);
    setError(null);
  }, [open, server]);

  const canSave = useMemo(() => {
    if (busy) return false;
    if (name.trim().length === 0) return false;
    if (transport === "stdio") return command.trim().length > 0;
    if (url.trim().length === 0) return false;
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    } catch {
      return false;
    }
    return true;
  }, [busy, name, transport, command, url]);

  async function submit(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const input: ServerInput = {
      ...(server ? { id: server.id } : {}),
      name: name.trim(),
      transport,
      auth: transport === "stdio" ? "none" : auth,
      ...(transport === "http" ? { url: url.trim() } : {}),
      args: args.split("\n").map((line) => line.trim()).filter(Boolean),
      ...(transport === "stdio"
        ? {
            command: command.trim(),
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          }
        : {}),
      // Omitted means "leave what is stored"; a credential field the user did
      // not touch is not a credential the user cleared.
      ...(auth === "bearer" && bearerTouched ? { bearer } : {}),
      ...(auth === "headers" && headersTouched ? { headers: recordFrom(headers) } : {}),
      ...(transport === "stdio" && envTouched ? { env: recordFrom(env) } : {}),
      ...(auth === "oauth" ? { oauthClientId: clientId.trim(), oauthScopes: scopes.trim() } : {}),
      ...(auth === "oauth" && clientSecretTouched ? { oauthClientSecret: clientSecret } : {}),
      enabled: server?.enabled ?? true,
      connect: true,
      ...(currentOrigin() ? { origin: currentOrigin() } : {}),
    };
    try {
      const result = editing ? await rpc.serverUpdate(input) : await rpc.serverCreate(input);
      setBusy(false);
      onSaved();
      if (result.authorizationUrl) {
        // The whole point of connecting here: a wrong URL fails in the dialog,
        // and a server that needs a sign-in takes you straight to it.
        window.location.assign(result.authorizationUrl);
        return;
      }
      onOpenChange(false);
    } catch (caught) {
      setBusy(false);
      setError(errorText(caught));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${server?.name ?? ""}` : "Add an MCP server"}</DialogTitle>
          <DialogDescription>
            {transport === "stdio"
              ? "A program this machine runs for BB and talks to over stdio."
              : "A hosted MCP endpoint, reached over HTTP."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["http", "Remote server"],
                ["stdio", "Local command"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTransport(value)}
                className={`h-9 rounded-md border text-sm transition-colors ${
                  transport === value
                    ? "border-foreground/40 bg-muted font-medium"
                    : "border-border text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              placeholder="Linear"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {transport === "http" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-url">URL</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  placeholder="https://mcp.linear.app/mcp"
                  className="font-mono text-xs"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Authentication</Label>
                <Select value={auth} onValueChange={(value) => setAuth(value as McpAuth)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(AUTH_LABELS) as McpAuth[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {AUTH_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {auth === "bearer" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-bearer">Token</Label>
                  <Input
                    id="mcp-bearer"
                    type="password"
                    value={bearer}
                    placeholder={server?.hasBearer ? "Stored - type to replace" : "Paste the token"}
                    onChange={(event) => {
                      setBearer(event.target.value);
                      setBearerTouched(true);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">Sent as an Authorization: Bearer header.</p>
                </div>
              ) : null}

              {auth === "headers" ? (
                <div className="space-y-1.5">
                  <Label>Headers</Label>
                  {headers.length === 0 && server?.hasHeaders ? (
                    <p className="text-xs text-muted-foreground">
                      Headers are stored. Add a row to replace them.
                    </p>
                  ) : null}
                  <PairEditor
                    pairs={headers}
                    onChange={(next) => {
                      setHeaders(next);
                      setHeadersTouched(true);
                    }}
                    namePlaceholder="X-Api-Key"
                    valuePlaceholder="value"
                    addLabel="Add header"
                    secret
                  />
                </div>
              ) : null}

              {auth === "oauth" ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Saving connects, then sends you to the provider to approve access.
                  </p>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setAdvanced(!advanced)}
                  >
                    {advanced ? "Hide" : "Show"} client details
                  </button>
                  {advanced ? (
                    <div className="space-y-2 rounded-md border p-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-client-id">Client ID</Label>
                        <Input
                          id="mcp-client-id"
                          value={clientId}
                          placeholder="Leave empty to register automatically"
                          className="h-8 font-mono text-xs"
                          onChange={(event) => setClientId(event.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-client-secret">Client secret</Label>
                        <Input
                          id="mcp-client-secret"
                          type="password"
                          value={clientSecret}
                          placeholder={server?.hasOAuthClientSecret ? "Stored - type to replace" : "Optional"}
                          className="h-8 font-mono text-xs"
                          onChange={(event) => {
                            setClientSecret(event.target.value);
                            setClientSecretTouched(true);
                          }}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="mcp-scopes">Scopes</Label>
                        <Input
                          id="mcp-scopes"
                          value={scopes}
                          placeholder="read write"
                          className="h-8 font-mono text-xs"
                          onChange={(event) => setScopes(event.target.value)}
                        />
                      </div>
                      {server?.redirectUri ? (
                        <p className="break-all font-mono text-[11px] text-muted-foreground">
                          Redirect: {server.redirectUri}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={command}
                  placeholder="npx"
                  className="font-mono text-xs"
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-args">Arguments</Label>
                <Textarea
                  id="mcp-args"
                  value={args}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home/me"}
                  className="min-h-[72px] font-mono text-xs"
                  onChange={(event) => setArgs(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">One per line.</p>
              </div>

              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setAdvanced(!advanced)}
              >
                {advanced ? "Hide" : "Show"} working directory and environment
              </button>
              {advanced ? (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="mcp-cwd">Working directory</Label>
                    <Input
                      id="mcp-cwd"
                      value={cwd}
                      placeholder="Leave empty for the BB working directory"
                      className="h-8 font-mono text-xs"
                      onChange={(event) => setCwd(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Environment</Label>
                    {env.length === 0 && server?.hasEnv ? (
                      <p className="text-xs text-muted-foreground">
                        Variables are stored. Add a row to replace them.
                      </p>
                    ) : null}
                    <PairEditor
                      pairs={env}
                      onChange={(next) => {
                        setEnv(next);
                        setEnvTouched(true);
                      }}
                      namePlaceholder="API_KEY"
                      valuePlaceholder="value"
                      addLabel="Add variable"
                      secret
                    />
                  </div>
                </div>
              ) : null}
            </>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave}>
            {busy ? "Connecting…" : editing ? "Save" : "Add and connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
