import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  miseDoctorStatusSchema,
  miseOutdatedItemSchema,
  miseStatusSchema,
  miseTaskItemSchema,
  miseToolItemSchema,
} from "./lib/types";

const hostRefreshInput = z.object({ forceRefresh: z.boolean().optional() }).nullish();

export const hostSignals = {
  upgradeLog: {
    payload: z.object({
      jobId: z.string(),
      line: z.string(),
    }),
  },
} as const;

export const hostContract = defineRpcContract({
  getStatus: {
    input: hostRefreshInput,
    output: miseStatusSchema,
  },
  listTools: {
    input: hostRefreshInput,
    output: z.array(miseToolItemSchema),
  },
  listOutdated: {
    input: hostRefreshInput,
    output: z.array(miseOutdatedItemSchema),
  },
  listTasks: {
    input: hostRefreshInput,
    output: z.array(miseTaskItemSchema),
  },
  getEnv: {
    input: hostRefreshInput,
    output: z.record(z.string(), z.string()),
  },
  searchTools: {
    input: z.object({ query: z.string().min(1) }),
    output: z.array(z.object({ name: z.string(), description: z.string() })),
  },
  installTool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  uninstallTool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  useTool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().min(1),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  upgradeTools: {
    input: z.object({
      tools: z.array(z.string()).optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      upgraded: z.array(z.string()),
    }),
  },
  startUpgrade: {
    input: z.object({
      jobId: z.string(),
      tools: z.array(z.string()).optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
    }),
  },
  readConfig: {
    input: z.object({ filePath: z.string().min(1) }),
    output: z.object({ content: z.string() }),
  },
  writeConfig: {
    input: z.object({
      filePath: z.string().min(1),
      content: z.string(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  getDoctor: {
    input: z.null(),
    output: miseDoctorStatusSchema,
  },
  runTask: {
    input: z.object({
      task: z.string().min(1),
      args: z.array(z.string()).optional(),
    }),
    output: z.object({
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
    }),
  },
  getUniverseRoot: {
    input: z.null(),
    output: z.object({ path: z.string() }),
  },
});
