import { z } from "zod";

export const piSettingsSchema = z.object({
  lastChangelogVersion: z.string().optional(),
  packages: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default([]),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultThinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  theme: z.string().optional(),
}).passthrough();

export type PiSettings = z.infer<typeof piSettingsSchema>;

export interface PiModelOption {
  id: string;
  model: string;
  displayName: string;
  providerId: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export const mcpServerSchema = z.object({
  url: z.string().optional(),
  type: z.string().optional(),
  httpTransport: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  lifecycle: z.enum(["eager", "lazy"]).optional(),
  directTools: z.boolean().optional(),
  toolPrefix: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  oauth: z.boolean().optional(),
  disabled: z.boolean().optional(),
}).passthrough();

export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpConfigSchema = z.object({
  settings: z.object({
    toolPrefix: z.string().optional(),
    mcpFooterStatus: z.string().optional(),
    notifyOnStartupConnect: z.boolean().optional(),
  }).passthrough().default({}),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
}).passthrough();

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export type TestResult = {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  message: string;
};
export const PI_CONFIG_CHANGED = "pi-config-changed";
