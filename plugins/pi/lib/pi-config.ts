import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mcpConfigSchema,
  mcpServerSchema,
  piSettingsSchema,
  type McpConfig,
  type McpServer,
  type PiSettings,
  type TestResult,
} from "./types";

export * from "./types";

export function getPiDir(): string {
  if (process.env.PI_DIR) return process.env.PI_DIR;
  const standard = path.join(os.homedir(), ".pi/agent");
  if (fs.existsSync(standard)) return standard;
  const universe = path.join(os.homedir(), "universe/pi");
  if (fs.existsSync(universe)) return universe;
  return standard;
}

export function getSettingsPath(): string {
  return path.join(getPiDir(), "settings.json");
}

export function getMcpPath(): string {
  return path.join(getPiDir(), "mcp.json");
}

export async function readPiSettings(): Promise<PiSettings> {
  const filePath = getSettingsPath();
  if (!fs.existsSync(filePath)) {
    return {
      packages: [],
      extensions: [],
    };
  }
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return piSettingsSchema.parse(parsed);
}

export async function writePiSettings(settings: PiSettings): Promise<void> {
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  const content = JSON.stringify(settings, null, 2) + "\n";
  const bakPath = `${filePath}.bak`;
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  if (fs.existsSync(filePath)) {
    await fs.promises.copyFile(filePath, bakPath);
  }
  await fs.promises.writeFile(tmpPath, content, "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

export async function readMcpConfig(): Promise<McpConfig> {
  const filePath = getMcpPath();
  if (!fs.existsSync(filePath)) {
    return {
      settings: {
        toolPrefix: "none",
        mcpFooterStatus: "off",
        notifyOnStartupConnect: false,
      },
      mcpServers: {},
    };
  }
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return mcpConfigSchema.parse(parsed);
}

export async function writeMcpConfig(config: McpConfig): Promise<void> {
  const filePath = getMcpPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  const content = JSON.stringify(config, null, 2) + "\n";
  const bakPath = `${filePath}.bak`;
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  if (fs.existsSync(filePath)) {
    await fs.promises.copyFile(filePath, bakPath);
  }
  await fs.promises.writeFile(tmpPath, content, "utf8");
  await fs.promises.rename(tmpPath, filePath);

  // Invalidate Pi's MCP cache
  const cachePath = path.join(getPiDir(), "mcp-cache.json");
  if (fs.existsSync(cachePath)) {
    await fs.promises.unlink(cachePath).catch(() => {});
  }
}

export function expandEnvVars(text: string): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, varName) => process.env[varName] ?? "");
}

export async function testMcpServer(serverName: string, server: McpServer): Promise<TestResult> {
  const start = Date.now();
  if (server.url) {
    const rawUrl = expandEnvVars(server.url);
    const headers: Record<string, string> = {};
    if (server.headers) {
      for (const [k, v] of Object.entries(server.headers)) {
        headers[k] = expandEnvVars(v);
      }
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(rawUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;
      if (res.ok || res.status === 400 || res.status === 405 || res.status === 401) {
        return {
          ok: true,
          latencyMs,
          statusCode: res.status,
          message: `Reachable (HTTP ${res.status}) in ${latencyMs}ms`,
        };
      }
      return {
        ok: false,
        latencyMs,
        statusCode: res.status,
        message: `HTTP ${res.status} ${res.statusText}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        message: err.name === "AbortError" ? "Connection timed out after 7s" : err.message,
      };
    }
  }
  return {
    ok: true,
    latencyMs: 0,
    message: "Local command server configured",
  };
}
