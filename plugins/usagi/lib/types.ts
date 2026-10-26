import { z } from "zod";

export const meterSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  usedPercent: z.number().nullable().optional(),
  used: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  windowSeconds: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});

export type UsagiMeter = z.infer<typeof meterSchema>;

export const accountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  span: z.string().optional(),
  authStatus: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

export type UsagiAccount = z.infer<typeof accountSchema>;

export const usageSchema = z.object({
  accountId: z.string(),
  provider: z.string(),
  accountLabel: z.string().optional(),
  plan: z.string().optional(),
  meters: z.array(meterSchema).default([]),
  detailMeters: z.array(meterSchema).optional(),
  fetchedAt: z.number().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
});

export type UsagiUsage = z.infer<typeof usageSchema>;

export const accountItemSchema = z.object({
  account: accountSchema,
  usage: usageSchema.nullable().optional(),
});

export type UsagiAccountItem = z.infer<typeof accountItemSchema>;

/**
 * Provider presentation data published by the Usagi API (`GET /api` →
 * `providers`, plus `GET /api/providers`). Optional so a board cached by an
 * older build — or an older server — still parses.
 */
export const providerMetaSchema = z.object({
  name: z.string(),
  iconPath: z.string(),
});

export type UsagiProviderMeta = z.infer<typeof providerMetaSchema>;

export const boardDataSchema = z.object({
  generatedAt: z.number(),
  providers: z.record(z.string(), providerMetaSchema).optional(),
  accounts: z.array(accountItemSchema),
});

export type UsagiBoardData = z.infer<typeof boardDataSchema>;

/** SVG markup per provider id, fetched from the API's `iconPath` and inlined. */
export type UsagiProviderIcons = Record<string, string>;

/**
 * The label for a provider: prefer the API's name, fall back to the built-in
 * table, then to the raw id.
 */
export function providerLabel(
  providers: UsagiBoardData["providers"] | undefined,
  provider: string,
): string {
  return providers?.[provider]?.name ?? PROVIDER_META[provider]?.displayName ?? provider;
}

export type ProviderId =
  | "codex"
  | "antigravity"
  | "opencode-go"
  | "cursor"
  | "tavily"
  | "exa"
  | "composio"
  | "command-code"
  | string;

export const PROVIDER_META: Record<
  string,
  {
    displayName: string;
    description: string;
    badgeColor?: string;
  }
> = {
  codex: {
    displayName: "Codex",
    description: "OpenAI Codex OAuth session",
  },
  claude: {
    displayName: "Claude",
    description: "Claude Code session & weekly windows",
  },
  antigravity: {
    displayName: "Antigravity",
    description: "Gemini & Claude model quota",
  },
  "opencode-go": {
    displayName: "OpenCode Go",
    description: "Session quotas and windows",
  },
  cursor: {
    displayName: "Cursor",
    description: "Pro requests & Auto-composer",
  },
  tavily: {
    displayName: "Tavily",
    description: "Search API credits",
  },
  exa: {
    displayName: "Exa",
    description: "Neural search credit spend",
  },
  composio: {
    displayName: "Composio",
    description: "Agent tool-call & session quotas",
  },
  "command-code": {
    displayName: "Command Code",
    description: "Studio credits & session windows",
  },
};
