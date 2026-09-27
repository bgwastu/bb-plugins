import { execFile, spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  type MiseDoctorStatus,
  type MiseOutdatedItem,
  type MiseStatus,
  type MiseTaskItem,
  type MiseToolItem,
} from "./types";

const execFileAsync = promisify(execFile);

export function getUniverseRoot(): string {
  if (process.env.UNIVERSE_ROOT) return process.env.UNIVERSE_ROOT;
  const home = os.homedir();
  const candidates = [
    path.join(home, "Projects", "universe"),
    path.join(home, "universe"),
  ];
  for (const c of candidates) {
    try {
      if (fsSync.existsSync(c)) return c;
    } catch {}
  }
  return home;
}

let resolvedMiseBin: string | null = null;

export async function getMiseBin(): Promise<string> {
  if (resolvedMiseBin) return resolvedMiseBin;

  const home = os.homedir();
  const candidates = [
    process.env.MISE_BIN,
    path.join(home, ".local/bin/mise"),
    path.join(home, ".local/share/mise/shims/mise"),
    "/opt/homebrew/bin/mise",
    "/usr/local/bin/mise",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      resolvedMiseBin = candidate;
      return candidate;
    } catch {}
  }

  try {
    const { stdout } = await execFileAsync("which", ["mise"]);
    const bin = stdout.trim();
    if (bin) {
      resolvedMiseBin = bin;
      return bin;
    }
  } catch {}

  return "mise";
}

export async function execMise(
  args: string[],
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await getMiseBin();
  const cwd = getUniverseRoot();
  try {
    const res = await execFileAsync(bin, args, {
      cwd,
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function runMiseStreaming(
  args: string[],
  onLine: (line: string) => void,
  timeoutMs = 600_000,
): Promise<{ exitCode: number; error?: string }> {
  const bin = await getMiseBin();
  const cwd = getUniverseRoot();

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (res: { exitCode: number; error?: string }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(res);
    };

    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ exitCode: 1, error: "Command timed out" });
    }, timeoutMs);

    const handleLine = (raw: string) => {
      const cleaned = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trimEnd();
      if (cleaned) onLine(cleaned);
    };

    if (child.stdout) {
      const rlOut = readline.createInterface({ input: child.stdout });
      rlOut.on("line", handleLine);
    }

    if (child.stderr) {
      const rlErr = readline.createInterface({ input: child.stderr });
      rlErr.on("line", handleLine);
    }

    child.on("close", (exitCode) => {
      finish({ exitCode: exitCode ?? 0 });
    });

    child.on("error", (err) => {
      finish({ exitCode: 1, error: err.message });
    });
  });
}

interface CacheStore {
  tools?: { data: MiseToolItem[]; time: number };
  outdated?: { data: MiseOutdatedItem[]; time: number };
  tasks?: { data: MiseTaskItem[]; time: number };
  env?: { data: Record<string, string>; time: number };
  doctor?: { data: MiseDoctorStatus; time: number };
  status?: { data: MiseStatus; time: number };
}

const cache: CacheStore = {};
const inFlight = new Map<string, Promise<any>>();

export function invalidateCache(): void {
  for (const key of Object.keys(cache) as Array<keyof CacheStore>) {
    delete cache[key];
  }
  inFlight.clear();
}

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export async function getMiseVersion(): Promise<string> {
  const res = await execMise(["--version"]);
  const firstLine = res.stdout.trim().split("\n")[0] || "";
  return firstLine.replace(/^mise\s+/, "") || "unknown";
}

export async function getDoctor(forceRefresh = false): Promise<MiseDoctorStatus> {
  if (!forceRefresh && cache.doctor && Date.now() - cache.doctor.time < 30_000) {
    return cache.doctor.data;
  }

  return dedupe("doctor", async () => {
    const res = await execMise(["doctor"]);
    const out = res.stdout + "\n" + res.stderr;

    const versionMatch = out.match(/version:\s+([^\n]+)/i);
    const activatedMatch = out.match(/activated:\s+(yes|no)/i);
    const shimsMatch = out.match(/shims_on_path:\s+(yes|no)/i);
    const updateMatch = out.match(/self_update_available:\s+(yes|no)/i);

    const warnings: string[] = [];
    const problems: string[] = [];

    const warningMatches = out.matchAll(/(\d+\.\s+[^\n]+(?:\n\s+[^\n]+)*)/g);
    for (const m of warningMatches) {
      warnings.push(m[1].trim());
    }

    if (!out.includes("No problems found")) {
      const probMatch = out.match(/problems found:[\s\S]*?(?=\n\n|\n[a-z_]+:|$)/i);
      if (probMatch) {
        problems.push(probMatch[0].trim());
      }
    }

    const data: MiseDoctorStatus = {
      version: versionMatch ? versionMatch[1].trim() : "unknown",
      activated: activatedMatch ? activatedMatch[1].toLowerCase() === "yes" : false,
      shimsOnPath: shimsMatch ? shimsMatch[1].toLowerCase() === "yes" : false,
      selfUpdateAvailable: updateMatch ? updateMatch[1].toLowerCase() === "yes" : false,
      warnings,
      problems,
    };
    cache.doctor = { data, time: Date.now() };
    return data;
  });
}

export async function listOutdated(forceRefresh = false): Promise<MiseOutdatedItem[]> {
  if (!forceRefresh && cache.outdated && Date.now() - cache.outdated.time < 60_000) {
    return cache.outdated.data;
  }

  return dedupe("outdated", async () => {
    const res = await execMise(["outdated", "--json"]);
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(res.stdout);
    } catch {
      return [];
    }

    const items: MiseOutdatedItem[] = [];
    for (const [name, info] of Object.entries(data)) {
      if (!info) continue;
      items.push({
        name,
        current: info.current || "unknown",
        latest: info.latest || "unknown",
        requested: info.requested || "unknown",
        sourcePath: info.source?.path || null,
      });
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    cache.outdated = { data: items, time: Date.now() };
    return items;
  });
}

export async function listTools(forceRefresh = false): Promise<MiseToolItem[]> {
  if (!forceRefresh && cache.tools && Date.now() - cache.tools.time < 30_000) {
    return cache.tools.data;
  }

  return dedupe("tools", async () => {
    const [lsRes, outdatedItems] = await Promise.all([
      execMise(["ls", "--json"]),
      listOutdated(forceRefresh),
    ]);

    let lsData: Record<string, any[]> = {};
    try {
      lsData = JSON.parse(lsRes.stdout);
    } catch {}

    const outdatedMap = new Map<string, MiseOutdatedItem>();
    for (const item of outdatedItems) {
      outdatedMap.set(item.name, item);
    }

    const items: MiseToolItem[] = [];

    for (const [toolName, versions] of Object.entries(lsData)) {
      if (!Array.isArray(versions)) continue;

      let activeVersion: string | null = null;
      let requestedVersion: string | null = null;
      let sourcePath: string | null = null;
      const installedVersions: string[] = [];

      for (const v of versions) {
        if (v.version && !installedVersions.includes(v.version)) {
          installedVersions.push(v.version);
        }
        if (v.active) {
          activeVersion = v.version;
          requestedVersion = v.requested_version || null;
          if (v.source?.path) {
            sourcePath = v.source.path;
          }
        }
      }

      if (!activeVersion && versions.length > 0) {
        activeVersion = versions[0].version || null;
        if (versions[0].source?.path) {
          sourcePath = versions[0].source.path;
        }
      }

      const outdated = outdatedMap.get(toolName);
      const isOutdated = !!outdated;
      const latestVersion = outdated?.latest || null;

      items.push({
        name: toolName,
        activeVersion,
        installedVersions,
        requestedVersion,
        sourcePath,
        isOutdated,
        latestVersion,
      });
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    cache.tools = { data: items, time: Date.now() };
    return items;
  });
}

export async function listTasks(forceRefresh = false): Promise<MiseTaskItem[]> {
  if (!forceRefresh && cache.tasks && Date.now() - cache.tasks.time < 45_000) {
    return cache.tasks.data;
  }

  return dedupe("tasks", async () => {
    const res = await execMise(["tasks", "--json"]);
    let data: any[] = [];
    try {
      data = JSON.parse(res.stdout);
    } catch {
      return [];
    }

    if (!Array.isArray(data)) return [];

    const items: MiseTaskItem[] = data.map((t) => ({
      name: t.name || "unnamed",
      description: t.description || null,
      source: t.source || "",
      run: Array.isArray(t.run) ? t.run : [String(t.run || "")],
      depends: Array.isArray(t.depends) ? t.depends : [],
      dir: t.dir || null,
    }));
    cache.tasks = { data: items, time: Date.now() };
    return items;
  });
}

export async function getEnv(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && cache.env && Date.now() - cache.env.time < 60_000) {
    return cache.env.data;
  }

  return dedupe("env", async () => {
    const res = await execMise(["env", "--json"]);
    let envMap: Record<string, string> = {};
    try {
      envMap = JSON.parse(res.stdout);
    } catch {}
    cache.env = { data: envMap, time: Date.now() };
    return envMap;
  });
}

export async function installTool(
  tool: string,
  version?: string,
): Promise<{ ok: boolean; message: string }> {
  invalidateCache();
  const target = version ? `${tool}@${version}` : tool;
  const res = await execMise(["install", "-y", target], 300_000);
  if (res.exitCode === 0) {
    return { ok: true, message: `Installed ${target}` };
  }
  return { ok: false, message: res.stderr || res.stdout || `Failed to install ${target}` };
}

export async function uninstallTool(
  tool: string,
  version: string,
): Promise<{ ok: boolean; message: string }> {
  invalidateCache();
  const target = `${tool}@${version}`;
  const res = await execMise(["uninstall", "-y", target], 60_000);
  if (res.exitCode === 0) {
    return { ok: true, message: `Uninstalled ${target}` };
  }
  return { ok: false, message: res.stderr || res.stdout || `Failed to uninstall ${target}` };
}

export async function useTool(
  tool: string,
  version: string,
): Promise<{ ok: boolean; message: string }> {
  invalidateCache();
  const target = `${tool}@${version}`;
  const res = await execMise(["use", "-g", target], 120_000);
  if (res.exitCode === 0) {
    return { ok: true, message: `Pinned ${target} globally` };
  }
  return { ok: false, message: res.stderr || res.stdout || `Failed to set ${target}` };
}

export async function upgradeTools(
  tools?: string[],
): Promise<{ ok: boolean; message: string; upgraded: string[] }> {
  invalidateCache();
  const args = ["upgrade", "-y", ...(tools && tools.length > 0 ? tools : [])];
  const res = await execMise(args, 300_000);
  if (res.exitCode === 0) {
    const listStr = tools && tools.length > 0 ? tools.join(", ") : "all tools";
    return { ok: true, message: `Successfully upgraded ${listStr}`, upgraded: tools || [] };
  }
  return {
    ok: false,
    message: res.stderr || res.stdout || "Upgrade failed",
    upgraded: [],
  };
}

export async function searchRegistry(query: string): Promise<Array<{ name: string; description: string }>> {
  const res = await execMise(["search", query], 15_000);
  const lines = res.stdout.split("\n");
  const results: Array<{ name: string; description: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (match) {
      results.push({ name: match[1], description: match[2] });
    } else {
      results.push({ name: trimmed, description: "" });
    }
  }

  return results.slice(0, 30);
}

export async function getStatus(forceRefresh = false): Promise<MiseStatus> {
  if (!forceRefresh && cache.status && Date.now() - cache.status.time < 30_000) {
    return cache.status.data;
  }

  return dedupe("status", async () => {
    const [version, doctor, tools, outdated, tasks, bin] = await Promise.all([
      getMiseVersion(),
      getDoctor(forceRefresh),
      listTools(forceRefresh),
      listOutdated(forceRefresh),
      listTasks(forceRefresh),
      getMiseBin(),
    ]);

    const data: MiseStatus = {
      machine: os.hostname(),
      miseVersion: version,
      miseBin: bin,
      toolsCount: tools.length,
      outdatedCount: outdated.length,
      tasksCount: tasks.length,
      doctor,
    };
    cache.status = { data, time: Date.now() };
    return data;
  });
}

export async function readConfigFile(filePath: string): Promise<string> {
  const resolved = filePath.startsWith("/")
    ? filePath
    : filePath.startsWith("~")
      ? path.join(os.homedir(), filePath.slice(1))
      : path.join(getUniverseRoot(), filePath);
  try {
    return await fs.readFile(resolved, "utf8");
  } catch (err: any) {
    return `# Failed to read ${resolved}: ${err.message}`;
  }
}

export async function writeConfigFile(filePath: string, content: string): Promise<{ ok: boolean; message: string }> {
  invalidateCache();
  const resolved = filePath.startsWith("/")
    ? filePath
    : filePath.startsWith("~")
      ? path.join(os.homedir(), filePath.slice(1))
      : path.join(getUniverseRoot(), filePath);
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    return { ok: true, message: `Saved ${resolved}` };
  } catch (err: any) {
    return { ok: false, message: `Failed to write ${resolved}: ${err.message}` };
  }
}
