// "Does this tool work?" answered without leaving BB: pick a tool, fill in a
// form built from its own schema, run it, read the answer.
import { useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ServerView, ToolResult, ToolView } from "../../contract.js";
import { errorText } from "./data.js";
import { useApi } from "./rpc.js";

type JsonSchema = Record<string, unknown>;

interface Field {
  name: string;
  type: string;
  description: string | null;
  required: boolean;
  values: string[] | null;
}

function fieldsOf(schema: JsonSchema): Field[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: typeof property.type === "string" ? property.type : "string",
    description: typeof property.description === "string" ? property.description : null,
    required: required.includes(name),
    values: Array.isArray(property.enum) ? (property.enum as unknown[]).map(String) : null,
  }));
}

export function ToolTestDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  server: ServerView;
  tools: ToolView[];
  initialTool: string | null;
}) {
  const rpc = useApi();
  const [toolName, setToolName] = useState(props.initialTool ?? props.tools[0]?.name ?? "");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tool = useMemo(
    () => props.tools.find((candidate) => candidate.name === toolName) ?? null,
    [props.tools, toolName],
  );
  const fields = useMemo(() => (tool ? fieldsOf(tool.inputSchema) : []), [tool]);

  function reset(nextTool: string): void {
    setToolName(nextTool);
    setValues({});
    setRaw("");
    setResult(null);
    setError(null);
  }

  function argumentsFor(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (value === undefined || value === "") continue;
      if (field.type === "boolean") {
        args[field.name] = value === true;
        continue;
      }
      if (field.type === "number" || field.type === "integer") {
        const parsed = Number(value);
        args[field.name] = Number.isNaN(parsed) ? value : parsed;
        continue;
      }
      if (field.type === "array" || field.type === "object") {
        try {
          args[field.name] = JSON.parse(String(value));
        } catch {
          args[field.name] = value;
        }
        continue;
      }
      args[field.name] = value;
    }
    if (raw.trim().length > 0) {
      try {
        Object.assign(args, JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // The form fields are the contract; a raw block that does not parse is
        // ignored rather than blocking the run.
      }
    }
    return args;
  }

  async function run(): Promise<void> {
    if (!tool) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await rpc.toolCall({ serverId: props.server.id, tool: tool.name, arguments: argumentsFor() }),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Test a tool on {props.server.name}</DialogTitle>
          <DialogDescription>
            The call runs against the real server, with the same checks the agent gets.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Tool</Label>
            <Select value={toolName} onValueChange={reset}>
              <SelectTrigger className="h-9 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {props.tools.map((candidate) => (
                  <SelectItem key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tool?.description ? (
              <p className="text-xs text-muted-foreground">{tool.description.slice(0, 240)}</p>
            ) : null}
          </div>

          {fields.length > 0 ? (
            <div className="space-y-2 rounded-md border p-3">
              {fields.map((field) => (
                <div key={field.name} className="space-y-1">
                  <Label htmlFor={`field-${field.name}`} className="font-mono text-xs">
                    {field.name}
                    {field.required ? <span className="text-destructive"> *</span> : null}
                  </Label>
                  {field.type === "boolean" ? (
                    <Switch
                      checked={values[field.name] === true}
                      onCheckedChange={(checked) => setValues({ ...values, [field.name]: checked })}
                    />
                  ) : field.values ? (
                    <Select
                      value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
                      onValueChange={(next) => setValues({ ...values, [field.name]: next })}
                    >
                      <SelectTrigger className="h-8 font-mono text-xs">
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        {field.values.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : field.type === "object" || field.type === "array" ? (
                    <Textarea
                      id={`field-${field.name}`}
                      className="min-h-[60px] font-mono text-xs"
                      placeholder={field.type === "array" ? '["a", "b"]' : "{}"}
                      value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
                      onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                    />
                  ) : (
                    <Input
                      id={`field-${field.name}`}
                      type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                      className="h-8 font-mono text-xs"
                      value={typeof values[field.name] === "string" ? (values[field.name] as string) : ""}
                      onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                    />
                  )}
                  {field.description ? (
                    <p className="text-[11px] text-muted-foreground">{field.description}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Raw arguments (JSON)
            </summary>
            <Textarea
              className="mt-2 min-h-[80px] font-mono text-xs"
              placeholder="{}"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
            />
          </details>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          {result ? (
            <div className="space-y-1 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                {result.isError ? "The tool reported an error" : "Result"}, {result.durationMs} ms
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
                {result.content
                  .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
                  .join("\n")}
              </pre>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy || !tool}>
            {busy ? "Running…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
