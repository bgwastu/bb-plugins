import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { boardDataSchema, type UsagiBoardData } from "./lib/types";
import { formatResetCountdown, remainingPercent, clampPercent } from "./lib/format";

const DEFAULT_ENDPOINT = "";
const USAGI_UPDATED_CHANNEL = "usagi:updated";

export const rpcContract = defineRpcContract({
  usagi_get_usage: {
    input: z.object({ force: z.boolean().optional() }),
    output: z.object({
      ok: z.boolean(),
      data: boardDataSchema.nullable(),
      error: z.string().optional(),
    }),
  },
  usagi_refresh: {
    input: z.null(),
    output: z.object({
      ok: z.boolean(),
      data: boardDataSchema.nullable(),
      error: z.string().optional(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("Usagi AI usage plugin initializing...");

  const settings = bb.settings.define({
    endpoint: {
      type: "string",
      label: "Usagi API Endpoint",
      description: "Full URL to your Usagi /api endpoint, e.g. https://usagi.example/api",
      default: DEFAULT_ENDPOINT,
    },
    password: {
      type: "string",
      label: "Usagi Password / Token",
      description: "Optional shared password if USAGI_PASSWORD is set on the server",
      default: "",
      secret: true,
    },
    pollIntervalSeconds: {
      type: "string",
      label: "Polling Interval (seconds)",
      description: "How frequently to refresh usage in background (default: 60)",
      default: "60",
    },
    showHomepageCard: {
      type: "boolean",
      label: "Show homepage card",
      description:
        "Show the compact AI quota card on the home screen. Turn off to hide it.",
      default: true,
    },
  });

  let cachedBoard: UsagiBoardData | null =
    (await bb.storage.kv.get<UsagiBoardData>("usagi_board")) ?? null;

  async function fetchBoard(force = false): Promise<UsagiBoardData> {
    const config = await settings.get();
    const endpointVal = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
    if (!endpointVal) {
      throw new Error("Set the Usagi API Endpoint in plugin settings before connecting.");
    }
    let urlStr = endpointVal;
    if (force) {
      urlStr += urlStr.includes("?") ? "&force=1" : "?force=1";
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "bb-plugin-usagi/0.1.0",
    };

    const passwordVal = typeof config.password === "string" ? config.password.trim() : "";
    if (passwordVal.length > 0) {
      headers["Authorization"] = `Bearer ${passwordVal}`;
      headers["X-Usagi-Password"] = passwordVal;
    }

    const res = await fetch(urlStr, {
      headers,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${urlStr}`);
    }

    const rawJson = await res.json();
    const parsed = boardDataSchema.parse(rawJson);
    cachedBoard = parsed;
    await bb.storage.kv.set("usagi_board", parsed);

    bb.realtime.publish(USAGI_UPDATED_CHANNEL, {
      count: parsed.accounts.length,
      generatedAt: parsed.generatedAt,
    });

    return parsed;
  }

  // Register RPC Handlers
  bb.rpc.register(rpcContract, {
    usagi_get_usage: async ({ force }) => {
      try {
        if (!cachedBoard || force) {
          const fresh = await fetchBoard(Boolean(force));
          return { ok: true, data: fresh };
        }
        return { ok: true, data: cachedBoard };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        bb.log.warn(`Failed to get Usagi usage: ${message}`);
        return { ok: false, data: cachedBoard, error: message };
      }
    },
    usagi_refresh: async () => {
      try {
        const fresh = await fetchBoard(true);
        return { ok: true, data: fresh };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        bb.log.warn(`Failed to refresh Usagi usage: ${message}`);
        return { ok: false, data: cachedBoard, error: message };
      }
    },
  });

  // Background Polling Service
  bb.background.service("usagi-sync", {
    async start(signal) {
      bb.log.info("Starting Usagi background sync service...");
      // initial immediate fetch
      try {
        await fetchBoard(false);
      } catch (err: unknown) {
        bb.log.warn(`Initial Usagi sync failed: ${String(err)}`);
      }

      while (!signal.aborted) {
        const config = await settings.get();
        const rawSec = typeof config.pollIntervalSeconds === "string" ? parseInt(config.pollIntervalSeconds, 10) : 60;
        const intervalMs = Math.max(30, Number.isFinite(rawSec) ? rawSec : 60) * 1000;
        await sleep(intervalMs, signal);
        if (signal.aborted) break;

        try {
          await fetchBoard(false);
        } catch (err: unknown) {
          bb.log.warn(`Background Usagi sync failed: ${String(err)}`);
        }
      }
    },
  });

  // Register Agent Tool
  if (false) bb.agents.registerTool({
    name: "get_ai_usage",
    description:
      "Get real-time AI provider quotas and usage for Codex, Antigravity (Gemini/Claude), Cursor, Tavily, Exa, Composio, and Command Code. Use this to verify model allowances and rate-limit reset times before or during heavy tasks.",
    presentation: {
      label: {
        pending: "Fetching live AI usage quotas from Usagi",
        completed: "Retrieved live AI usage quotas from Usagi",
      },
    },
    parameters: z.object({
      forceRefresh: z
        .boolean()
        .optional()
        .describe("Bypass cache and force an immediate provider refresh"),
    }),
    async execute({ forceRefresh }) {
      try {
        const board = await fetchBoard(Boolean(forceRefresh));
        const summary = board.accounts.map((item) => {
          const acc = item.account;
          const u = item.usage;
          return {
            provider: acc.provider,
            name: acc.name,
            plan: u?.plan ?? "unknown",
            status: u?.status ?? "unknown",
            meters: (u?.meters ?? []).map((m) => ({
              id: m.id,
              label: m.label,
              kind: m.kind,
              usedPercent: m.usedPercent,
              remaining: m.remaining,
              limit: m.limit,
              unit: m.unit,
              resetsIn: m.resetsAt ? formatResetCountdown(m.resetsAt) : undefined,
            })),
          };
        });

        return JSON.stringify(
          {
            generatedAt: new Date(board.generatedAt).toISOString(),
            accountsCount: board.accounts.length,
            accounts: summary,
          },
          null,
          2,
        );
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to fetch AI usage: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // Register CLI Command
  bb.cli.register({
    name: "usagi",
    summary: "Real-time AI usage and quota tracker across accounts and providers",
    commands: [
      {
        name: "status",
        summary: "Show formatted AI usage overview across all provider accounts",
        usage: "bb usagi [status]",
      },
      {
        name: "list",
        summary: "List all accounts and quotas as JSON or text",
        usage: "bb usagi list [--json]",
      },
      {
        name: "refresh",
        summary: "Force re-fetch from Usagi endpoint",
        usage: "bb usagi refresh",
      },
    ],
    async run(argv) {
      const sub = (argv[0] ?? "status").toLowerCase();

      if (sub === "refresh") {
        try {
          const fresh = await fetchBoard(true);
          return {
            exitCode: 0,
            stdout: `✓ Refreshed Usagi AI board (${fresh.accounts.length} accounts at ${new Date(fresh.generatedAt).toLocaleTimeString()})\n`,
          };
        } catch (err) {
          return {
            exitCode: 1,
            stderr: `Error refreshing: ${err instanceof Error ? err.message : String(err)}\n`,
          };
        }
      }

      if (sub === "list") {
        try {
          const board = cachedBoard ?? (await fetchBoard(false));
          if (argv.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify(board, null, 2) + "\n",
            };
          }
          const lines = board.accounts.map((a) => {
            const mSummary = (a.usage?.meters ?? [])
              .map((m) => {
                if (m.usedPercent != null) {
                  return `${m.label}: ${Math.round(100 - m.usedPercent)}% left`;
                }
                if (m.remaining != null && m.limit != null) {
                  return `${m.label}: ${m.remaining}/${m.limit} left`;
                }
                return `${m.label}`;
              })
              .join(" | ");
            return `• [${a.account.provider.toUpperCase()}] ${a.account.name} (${a.usage?.plan ?? "free"}) — ${mSummary}`;
          });
          return {
            exitCode: 0,
            stdout: `Usagi AI Usage Accounts (${board.accounts.length}):\n${lines.join("\n")}\n`,
          };
        } catch (err) {
          return {
            exitCode: 1,
            stderr: `Error: ${err instanceof Error ? err.message : String(err)}\n`,
          };
        }
      }

      // Default: "status" or empty
      try {
        const board = cachedBoard ?? (await fetchBoard(false));
        const out: string[] = [];

        out.push("");
        out.push("🐰 Usagi AI Usage Board");
        out.push(`Generated: ${new Date(board.generatedAt).toLocaleString()} · ${board.accounts.length} accounts`);
        out.push("=".repeat(64));

        for (const item of board.accounts) {
          const { account, usage } = item;
          const plan = usage?.plan ? `[${usage.plan.toUpperCase()}]` : "";
          out.push(`\n▶ ${account.provider.toUpperCase()} · ${account.name} ${plan}`);

          if (!usage || usage.status === "error") {
            out.push(`  ! Status: ${usage?.error ?? "unavailable"}`);
            continue;
          }

          const meters = usage.meters ?? [];
          if (meters.length === 0) {
            out.push("  (no active meters)");
            continue;
          }

          for (const m of meters) {
            let meterLine = `  - ${m.label.padEnd(26)}: `;
            if (m.usedPercent != null) {
              const rem = remainingPercent(clampPercent(m.usedPercent));
              meterLine += `${Math.round(rem)}% remaining (${Math.round(m.usedPercent)}% used)`;
            } else if (m.remaining != null && m.limit != null) {
              if (m.unit === "USD") {
                meterLine += `$${m.remaining.toFixed(2)} / $${m.limit.toFixed(2)} left`;
              } else {
                meterLine += `${m.remaining} / ${m.limit} ${m.unit ?? "left"}`;
              }
            } else if (m.used != null) {
              if (m.unit === "USD") {
                meterLine += `$${m.used.toFixed(4)} spent`;
              } else {
                meterLine += `${m.used} ${m.unit ?? "used"}`;
              }
            }

            if (m.resetsAt) {
              const resetsIn = formatResetCountdown(m.resetsAt);
              if (resetsIn !== "—") {
                meterLine += ` [resets in ${resetsIn}]`;
              }
            }
            out.push(meterLine);
          }
        }

        out.push("");
        out.push("=".repeat(64));
        out.push("Run 'bb usagi refresh' to force update · Open BB sidebar to view GUI");
        out.push("");

        return { exitCode: 0, stdout: out.join("\n") };
      } catch (err) {
        return {
          exitCode: 1,
          stderr: `Failed to load Usagi status: ${err instanceof Error ? err.message : String(err)}\n`,
        };
      }
    },
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
