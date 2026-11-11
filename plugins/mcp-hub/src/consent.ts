import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolResult,
  PluginInteractionCancelReason,
  PluginInteractionResult,
} from "@get-bb/plugin-sdk";
import { CONSENT_RENDERER_ID, consentResponseSchema } from "../contract.js";
import type { ToolExecutor } from "./server/tools.js";
import type { CatalogTool } from "./storage/registry.js";

/**
 * How long a consent prompt may stay open.
 *
 * Consent and the upstream MCP call share ONE `execute()`, and the transport
 * carrying that call has a ceiling near five minutes (undici's `bodyTimeout`
 * on the daemon's tool-call round trip). The two budgets stack, so this and
 * `CALL_TIMEOUT_MS` are chosen together: 120s here plus 90s there leaves
 * room for the round trip itself. Neither may be raised on its own.
 */
export const CONSENT_TIMEOUT_MS = 120_000;

/**
 * BB rejects an interaction whose title is longer than this, so an over-long
 * upstream tool name would cost the user the prompt entirely. The two names
 * get their own budgets rather than sharing one: truncating the composed
 * title would drop the server name off the end, and "which server is this
 * going to" is half of what the user is being asked.
 */
const TITLE_MAX_CHARS = 160;
const TITLE_TOOL_CHARS = 100;
const TITLE_SERVER_CHARS = 40;

/**
 * How much of the arguments the prompt shows. `requestInput` rejects a
 * payload over 64 KiB, and a rejected payload denies a call the user never
 * saw - so a large argument object is truncated rather than pasted in whole.
 */
const SUMMARY_MAX_CHARS = 800;

export type ConsentDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ConsentGate {
  /** Resolves true when the call may proceed. */
  check(
    tool: CatalogTool,
    args: Record<string, unknown>,
    ctx: PluginAgentToolContext,
  ): Promise<ConsentDecision>;
  forgetThread(threadId: string): void;
}

const ALLOWED: ConsentDecision = { allowed: true };

/**
 * Shortens `text` to `budget` characters without splitting a surrogate pair.
 *
 * A lone surrogate would survive `JSON.stringify` as an escape, so this is
 * about what the prompt renders rather than about validity: half an emoji in
 * the title of the only thing standing between a model and the user's inbox
 * reads like a bug in the prompt itself.
 */
function truncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const ellipsis = "...";
  let kept = "";
  for (const codePoint of text) {
    if (kept.length + codePoint.length > budget - ellipsis.length) break;
    kept += codePoint;
  }
  return `${kept}${ellipsis}`;
}

/**
 * A one-line preview of what the model is asking to send.
 *
 * `JSON.stringify` returns undefined for a bare `undefined` and throws on a
 * cycle or a BigInt, and neither may cost the user their prompt: an argument
 * object this cannot render still gets a summary saying so, and the user
 * still gets asked.
 */
export function summarizeArguments(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = "";
  }
  if (json === "") return "(arguments could not be shown)";
  return truncate(json, SUMMARY_MAX_CHARS);
}

/** What to tell the model when the prompt was cancelled rather than answered. */
function cancellationReason(
  reason: PluginInteractionCancelReason,
  toolName: string,
): string {
  const prefix = `The user did not approve the MCP tool "${toolName}"`;
  switch (reason) {
    case "user":
      return `${prefix}: they declined the request.`;
    case "timeout":
      return `${prefix}: the request was cancelled because it went unanswered. `
        + "Ask whether they still want it before calling this tool again.";
    case "thread-stopped":
      return `${prefix}: the thread was stopped while the request was open.`;
    case "thread-deleted":
      return `${prefix}: the thread was deleted while the request was open.`;
    case "plugin-disposed":
      return `${prefix}: the MCP plugin was reloaded or disabled while the `
        + "request was open. Try again.";
    case "server-restarted":
      return `${prefix}: the BB server restarted while the request was open. `
        + "Try again.";
    case "request-aborted":
      return `${prefix}: the call was aborted while the request was open.`;
  }
}

/**
 * The consent gate: a user prompt in front of every tool marked `ask`.
 *
 * `requestInput` is injected rather than a whole `bb`, so the gate is
 * testable without a host and cannot reach anything else on the plugin API.
 *
 * NOT IMPLEMENTED - design section 7's headless/subagent rule. The design says
 * a tool marked `ask` must be DENIED outright, without prompting, when the
 * caller is a headless run or a subagent: there is nobody at a screen to
 * answer, so asking is theatre. What happens today instead is that
 * `requestInput` opens a prompt no one can see and {@link CONSENT_TIMEOUT_MS}
 * closes it two minutes later as `cancelled`/`timeout`, which the model is
 * told about and the call does not run. So the behaviour fails CLOSED and no
 * write escapes - it just costs the caller 120 seconds to learn it. Building
 * the rule properly needs a `message.dispatch` hook to tell those callers
 * apart, which is a scope decision the user has not made.
 */
export function createConsentGate(deps: {
  requestInput: BbPluginApi["ui"]["requestInput"];
  serverName(serverId: string): string;
  timeoutMs?: number;
}): ConsentGate {
  const timeoutMs = deps.timeoutMs ?? CONSENT_TIMEOUT_MS;

  /** threadId -> registered names the user allowed for the rest of the thread. */
  const allowances = new Map<string, Set<string>>();

  /**
   * threadId -> tail of that thread's prompt queue.
   *
   * A thread holds at most ONE pending interaction, and a second concurrent
   * `requestInput` for the same thread throws. Both Claude and Codex emit
   * parallel tool calls, so two write tools in one turn would make the second
   * a denial the user never saw. Prompts therefore run one at a time per
   * thread, and the allowance cache is read INSIDE the queued task - see
   * `check` - so a "thread" grant from the first prompt covers the second
   * without asking again.
   */
  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    // Both arms run `task`: a link that rejected must not wedge the thread's
    // queue for the rest of the turn.
    const running = previous.then(task, task);
    // The stored tail can never reject, or an unhandled rejection would
    // escape from a link nobody awaits.
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    queues.set(threadId, settled);
    void settled.then(() => {
      // Only the last link clears the entry, so the map stays bounded by the
      // number of threads prompting right now rather than by threads seen.
      if (queues.get(threadId) === settled) queues.delete(threadId);
    });
    return running;
  }

  async function prompt(
    tool: CatalogTool,
    args: Record<string, unknown>,
    ctx: PluginAgentToolContext,
  ): Promise<ConsentDecision> {
    const serverName = deps.serverName(tool.serverId);
    let result: PluginInteractionResult;
    try {
      result = await deps.requestInput({
        threadId: ctx.threadId,
        rendererId: CONSENT_RENDERER_ID,
        title: truncate(
          `Run "${truncate(tool.upstreamName, TITLE_TOOL_CHARS)}" on `
          + `${truncate(serverName, TITLE_SERVER_CHARS)}?`,
          TITLE_MAX_CHARS,
        ),
        payload: {
          serverName,
          toolName: tool.upstreamName,
          summary: summarizeArguments(args),
          destructive: !tool.readOnly,
        },
        timeoutMs,
        // Passed through even though a stopped thread already cancels the
        // prompt for us: an aborted tool-call round trip has to release the
        // interaction too, or the user is left answering a dead question.
      }, { signal: ctx.signal });
    } catch (error) {
      // A foreign interaction - Claude's own AskUserQuestion, a permission
      // prompt - already holds this thread's one slot, so `requestInput`
      // threw. Refusing retryably beats failing the turn.
      return {
        allowed: false,
        reason: `Could not ask the user to approve the MCP tool "${tool.upstreamName}": `
          + `${String(error)}. This usually means another prompt is already open `
          + "in this thread; wait for the user to answer it, then call this tool again.",
      };
    }

    if (result.outcome === "cancelled") {
      return { allowed: false, reason: cancellationReason(result.reason, tool.upstreamName) };
    }

    const parsed = consentResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      // Fail closed: an answer this cannot read is not an approval.
      return {
        allowed: false,
        reason: `The approval for the MCP tool "${tool.upstreamName}" could not be read, `
          + "so the call was not made. Try again.",
      };
    }
    if (parsed.data.decision === "deny") {
      return {
        allowed: false,
        reason: `The user declined the MCP tool "${tool.upstreamName}". `
          + "Do not retry it without asking them first.",
      };
    }
    if (parsed.data.decision === "thread") {
      let allowed = allowances.get(ctx.threadId);
      if (!allowed) {
        allowed = new Set<string>();
        allowances.set(ctx.threadId, allowed);
      }
      allowed.add(tool.registeredName);
    }
    return ALLOWED;
  }

  return {
    async check(tool, args, ctx) {
      // Reads are never worth a prompt, and asking for one would train the
      // user to approve without reading.
      if (!tool.ask) return ALLOWED;
      return enqueue(ctx.threadId, async () => {
        // Deliberately after the queue: a grant made by the prompt ahead of
        // this one in the same turn covers this call too.
        if (allowances.get(ctx.threadId)?.has(tool.registeredName)) return ALLOWED;
        return prompt(tool, args, ctx);
      });
    },

    forgetThread(threadId) {
      allowances.delete(threadId);
    },
  };
}

/**
 * Wraps a {@link ToolExecutor} so nothing upstream runs without consent.
 *
 * A refusal comes back as an `isError` result rather than a throw: the model
 * is told what happened and the turn survives.
 */
export function withConsent(execute: ToolExecutor, gate: ConsentGate): ToolExecutor {
  return async (tool, args, ctx) => {
    const decision = await gate.check(tool, args, ctx);
    if (decision.allowed) return execute(tool, args, ctx);
    return {
      content: [{ type: "text", text: decision.reason }],
      isError: true,
    } satisfies PluginAgentToolResult;
  };
}
