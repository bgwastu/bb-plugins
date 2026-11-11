// The consent prompt, rendered inside a thread whenever an MCP write tool is
// about to run.
//
// This component is the entire user-facing half of the plugin's only safety
// property. BB puts every plugin tool into Claude Code's `allowedTools` and
// Codex forwards tool calls with no approval hook, so nothing else asks: what
// the user reads here is what they are actually authorizing.
import { type ReactElement, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { consentPayloadSchema, type McpConsentResponse } from "../../contract.js";

type Decision = McpConsentResponse["decision"];

export function ConsentPrompt(
  { interaction, submit, cancel }: PluginPendingInteractionProps,
): ReactElement {
  // Latched rather than reset on success: the interaction unmounts when the
  // backend's promise resolves, and a second click before that would answer a
  // question that is already answered.
  const [answering, setAnswering] = useState(false);
  const parsed = consentPayloadSchema.safeParse(interaction.payload);

  const decide = (decision: Decision): void => {
    if (answering) return;
    setAnswering(true);
    void submit({ decision }).catch(() => {
      // The answer never reached the backend, so the question is still open.
      setAnswering(false);
    });
  };

  if (!parsed.success) {
    // Cancelled rather than denied: the user was shown nothing, so they did
    // not decline anything. The gate treats a cancellation as a refusal
    // either way, but only one of the two is honest about what happened.
    return (
      <div className="rounded-md border border-border bg-card p-3">
        <p className="text-sm text-foreground">
          An MCP tool asked for approval, but the request could not be read.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing was run. Dismiss this and ask the assistant to try again.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={answering}
          onClick={() => {
            setAnswering(true);
            void cancel().catch(() => { setAnswering(false); });
          }}
        >
          Dismiss
        </Button>
      </div>
    );
  }

  const { serverName, toolName, summary, destructive } = parsed.data;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-sm font-medium text-foreground">
        Run <span className="font-mono">{toolName}</span> on {serverName}?
      </p>
      {destructive ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This tool can change or send data outside BB.
        </p>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">Arguments</p>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 text-xs text-foreground">
        {summary}
      </pre>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={answering} onClick={() => { decide("once"); }}>
          Allow once
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answering}
          onClick={() => { decide("thread"); }}
        >
          Always allow {toolName} in this thread
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={answering}
          onClick={() => { decide("deny"); }}
        >
          Deny
        </Button>
      </div>
      {/*
        Spelled out because the wording alone reads like "allow this call".
        A thread grant is argument-independent: approving a send to one
        address permits a send to any other, for this tool, until the thread
        ends. The user has to be able to see that before clicking it.
      */}
      <p className="mt-2 text-xs text-muted-foreground">
        &quot;Always allow&quot; covers every later call to{" "}
        <span className="font-mono">{toolName}</span> in this thread, with any
        arguments - not just the ones above.
      </p>
    </div>
  );
}
