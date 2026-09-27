import { z } from "zod";

export const MISE_STATE_CHANGED = "mise:state-changed";
export const MISE_UPGRADE_EVENT = "mise:upgrade-event";

export const upgradeJobSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  tools: z.array(z.string()).optional(),
  status: z.enum(["running", "completed", "failed"]),
  logs: z.array(z.string()),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type UpgradeJob = z.infer<typeof upgradeJobSchema>;

export const miseToolItemSchema = z.object({
  name: z.string(),
  activeVersion: z.string().nullable(),
  installedVersions: z.array(z.string()),
  requestedVersion: z.string().nullable(),
  sourcePath: z.string().nullable(),
  isOutdated: z.boolean(),
  latestVersion: z.string().nullable(),
});

export type MiseToolItem = z.infer<typeof miseToolItemSchema>;

export const miseOutdatedItemSchema = z.object({
  name: z.string(),
  current: z.string(),
  latest: z.string(),
  requested: z.string(),
  sourcePath: z.string().nullable(),
});

export type MiseOutdatedItem = z.infer<typeof miseOutdatedItemSchema>;

export const miseTaskItemSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  source: z.string(),
  run: z.array(z.string()),
  depends: z.array(z.string()).default([]),
  dir: z.string().nullable(),
});

export type MiseTaskItem = z.infer<typeof miseTaskItemSchema>;

export const miseDoctorStatusSchema = z.object({
  version: z.string(),
  activated: z.boolean(),
  shimsOnPath: z.boolean(),
  selfUpdateAvailable: z.boolean(),
  warnings: z.array(z.string()),
  problems: z.array(z.string()),
});

export type MiseDoctorStatus = z.infer<typeof miseDoctorStatusSchema>;

export const miseStatusSchema = z.object({
  machine: z.string(),
  miseVersion: z.string(),
  miseBin: z.string().default(""),
  toolsCount: z.number(),
  outdatedCount: z.number(),
  tasksCount: z.number(),
  doctor: miseDoctorStatusSchema,
});

export type MiseStatus = z.infer<typeof miseStatusSchema>;
