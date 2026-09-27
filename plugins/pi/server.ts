import os from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  expandEnvVars,
  getMcpPath,
  getPiDir,
  getSettingsPath,
  mcpConfigSchema,
  mcpServerSchema,
  piSettingsSchema,
  readMcpConfig,
  readPiSettings,
  testMcpServer,
  writeMcpConfig,
  writePiSettings,
  type McpConfig,
  type McpServer,
  type PiSettings,
} from "./lib/pi-config";
import { PI_CONFIG_CHANGED } from "./lib/types";

export const rpcContract = defineRpcContract({
  pi_get_status: {
    input: z.null(),
    output: z.object({
      machine: z.string(),
      piDir: z.string(),
      settingsPath: z.string(),
      mcpPath: z.string(),
      mcpCount: z.number(),
      defaultModel: z.string().optional(),
      defaultProvider: z.string().optional(),
      defaultThinkingLevel: z.string().optional(),
    }),
  },
  pi_get_settings: {
    input: z.null(),
    output: piSettingsSchema,
  },
  pi_get_models: {
    input: z.null(),
    output: z.object({
      models: z.array(z.object({
        id: z.string(),
        model: z.string(),
        displayName: z.string(),
        providerId: z.string(),
        supportedReasoningEfforts: z.array(z.string()),
        defaultReasoningEffort: z.string(),
      })),
      error: z.string().optional(),
    }),
  },
  pi_save_settings_raw: {
    input: z.object({ raw: z.string() }),
    output: piSettingsSchema,
  },
  pi_update_settings: {
    input: piSettingsSchema.partial(),
    output: piSettingsSchema,
  },
  pi_package_add: {
    input: z.object({ pkg: z.string().trim().min(1) }),
    output: piSettingsSchema,
  },
  pi_package_remove: {
    input: z.object({ pkg: z.string().trim().min(1) }),
    output: piSettingsSchema,
  },
  pi_get_mcp_config: {
    input: z.null(),
    output: mcpConfigSchema,
  },
  pi_save_mcp_raw: {
    input: z.object({ raw: z.string() }),
    output: mcpConfigSchema,
  },
  pi_mcp_upsert: {
    input: z.object({
      name: z.string().trim().min(1),
      server: mcpServerSchema,
    }),
    output: mcpConfigSchema,
  },
  pi_mcp_toggle: {
    input: z.object({
      name: z.string().trim().min(1),
      disabled: z.boolean(),
    }),
    output: mcpConfigSchema,
  },
  pi_mcp_verify_and_add: {
    input: z.object({
      name: z.string().trim().min(1),
      json: z.string(),
      testFirst: z.boolean().default(true),
    }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
      testResult: z
        .object({
          ok: z.boolean(),
          latencyMs: z.number(),
          message: z.string(),
        })
        .optional(),
    }),
  },
  pi_mcp_save_json: {
    input: z.object({
      originalName: z.string().trim().min(1),
      newName: z.string().trim().min(1).optional(),
      json: z.string(),
    }),
    output: z.object({
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  },
  pi_mcp_remove: {
    input: z.object({ name: z.string().trim().min(1) }),
    output: mcpConfigSchema,
  },
  pi_mcp_test: {
    input: z.object({ name: z.string().trim().min(1) }),
    output: z.object({
      ok: z.boolean(),
      latencyMs: z.number(),
      statusCode: z.number().optional(),
      message: z.string(),
    }),
  },
  pi_mcp_update_settings: {
    input: z.object({
      toolPrefix: z.string().optional(),
      mcpFooterStatus: z.string().optional(),
      notifyOnStartupConnect: z.boolean().optional(),
    }),
    output: mcpConfigSchema,
  },
});

type PiCatalogModel = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: Record<string, unknown>;
};

async function readPiCatalogModels(): Promise<ReturnType<typeof normalizePiModels>> {
  const catalogs = [
    { file: "cliproxyapi-models.json", providerId: "cliproxyapi" },
    { file: "commandcode-models.json", providerId: "commandcode" },
  ];
  const models: ReturnType<typeof normalizePiModels> = [];

  for (const catalog of catalogs) {
    try {
      const raw = JSON.parse(await readFile(join(getPiDir(), catalog.file), "utf8")) as {
        models?: PiCatalogModel[];
      };
      for (const entry of raw.models ?? []) {
        const model = typeof entry.id === "string" ? entry.id : "";
        if (!model) continue;
        models.push(...normalizePiModels([entry], catalog.providerId));
      }
    } catch {
      // A provider catalog is optional; keep reading the other Pi catalogs.
    }
  }

  return models;
}

function normalizePiModels(entries: PiCatalogModel[], providerId = ""): Array<{
  id: string;
  model: string;
  displayName: string;
  providerId: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
}> {
  return entries.flatMap((entry) => {
    const model = typeof entry.id === "string" ? entry.id : "";
    if (!model) return [];
    const efforts = Object.keys(entry.thinkingLevelMap ?? {}).filter(
      (effort) => entry.thinkingLevelMap?.[effort] != null,
    );
    const supportsReasoning = entry.reasoning === true || efforts.length > 0;
    const supportedReasoningEfforts = supportsReasoning
      ? efforts.length > 0
        ? efforts
        : ["off", "minimal", "low", "medium", "high", "xhigh"]
      : ["off"];
    return [{
      id: `${providerId}/${model}`,
      model,
      displayName:
        typeof entry.displayName === "string"
          ? entry.displayName
          : typeof entry.name === "string"
            ? entry.name
            : model,
      providerId,
      supportedReasoningEfforts,
      defaultReasoningEffort: supportsReasoning ? (efforts[0] ?? "low") : "off",
    }];
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("Pi Manager plugin loaded");

  async function notifyChange() {
    bb.realtime.publish(PI_CONFIG_CHANGED, { timestamp: Date.now() });
  }

  // --- RPC Handlers ---
  bb.rpc.register(rpcContract, {
    async pi_get_status() {
      const [settings, mcp] = await Promise.all([readPiSettings(), readMcpConfig()]);
      return {
        machine: os.hostname(),
        piDir: getPiDir(),
        settingsPath: getSettingsPath(),
        mcpPath: getMcpPath(),
        mcpCount: Object.keys(mcp.mcpServers || {}).length,
        defaultModel: settings.defaultModel,
        defaultProvider: settings.defaultProvider,
        defaultThinkingLevel: settings.defaultThinkingLevel,
      };
    },

    async pi_get_settings() {
      return await readPiSettings();
    },

    async pi_get_models() {
      try {
        const catalog = await bb.sdk.providers.models();
        const bbModels = catalog.models.map((entry) => {
            const providerId =
              entry.routeProviderId ?? entry.id.split("/", 1)[0] ?? "";
            return {
              id: entry.id,
              model: entry.model,
              displayName: entry.displayName,
              providerId,
              supportedReasoningEfforts: entry.supportedReasoningEfforts.map(
                (effort) => effort.reasoningEffort,
              ),
              defaultReasoningEffort: entry.defaultReasoningEffort,
            };
          });
        const piModels = await readPiCatalogModels();
        const merged = [...bbModels, ...piModels];
        return {
          models: Array.from(new Map(merged.map((model) => [model.id, model])).values()),
        };
      } catch (error: unknown) {
        return {
          models: await readPiCatalogModels(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async pi_save_settings_raw({ raw }) {
      const parsed = JSON.parse(raw);
      const validated = piSettingsSchema.parse(parsed);
      await writePiSettings(validated);
      await notifyChange();
      return validated;
    },

    async pi_update_settings(updates) {
      const current = await readPiSettings();
      const updated = { ...current, ...updates };
      await writePiSettings(updated);
      await notifyChange();
      return updated;
    },

    async pi_package_add({ pkg }) {
      const current = await readPiSettings();
      const packages = current.packages || [];
      if (!packages.includes(pkg)) {
        current.packages = [...packages, pkg];
        await writePiSettings(current);
        await notifyChange();
      }
      return current;
    },

    async pi_package_remove({ pkg }) {
      const current = await readPiSettings();
      const packages = current.packages || [];
      current.packages = packages.filter((p) => p !== pkg);
      await writePiSettings(current);
      await notifyChange();
      return current;
    },

    async pi_get_mcp_config() {
      return await readMcpConfig();
    },
    async pi_save_mcp_raw({ raw }) {
      const parsed = JSON.parse(raw);
      const validated = mcpConfigSchema.parse(parsed);
      await writeMcpConfig(validated);
      await notifyChange();
      return validated;
    },

    async pi_mcp_upsert({ name, server }) {
      const current = await readMcpConfig();
      current.mcpServers = current.mcpServers || {};
      current.mcpServers[name] = server;
      await writeMcpConfig(current);
      await notifyChange();
      return current;
    },

    async pi_mcp_toggle({ name, disabled }) {
      const current = await readMcpConfig();
      if (current.mcpServers && current.mcpServers[name]) {
        if (disabled) {
          current.mcpServers[name].disabled = true;
        } else {
          delete current.mcpServers[name].disabled;
        }
        await writeMcpConfig(current);
        await notifyChange();
      }
      return current;
    },

    async pi_mcp_verify_and_add({ name, json, testFirst }) {
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch (err: any) {
        return { ok: false, error: `Invalid JSON syntax: ${err.message}` };
      }

      // If json contains wrapped name: { "server-name": { url: ... } }
      let serverDef = parsed;
      if (parsed[name] && typeof parsed[name] === "object") {
        serverDef = parsed[name];
      }

      let validated: McpServer;
      try {
        validated = mcpServerSchema.parse(serverDef);
      } catch (err: any) {
        return { ok: false, error: `Schema validation failed: ${err.message}` };
      }

      let testRes: any;
      if (testFirst && validated.url) {
        testRes = await testMcpServer(name, validated);
        if (!testRes.ok) {
          return {
            ok: false,
            error: `Connection verification failed: ${testRes.message}`,
            testResult: testRes,
          };
        }
      }

      const current = await readMcpConfig();
      current.mcpServers = current.mcpServers || {};
      current.mcpServers[name] = validated;
      await writeMcpConfig(current);
      await notifyChange();

      return { ok: true, testResult: testRes };
    },

    async pi_mcp_save_json({ originalName, newName, json }) {
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch (err: any) {
        return { ok: false, error: `Invalid JSON syntax: ${err.message}` };
      }
      let validated: McpServer;
      try {
        validated = mcpServerSchema.parse(parsed);
      } catch (err: any) {
        return { ok: false, error: `Schema validation failed: ${err.message}` };
      }
      const current = await readMcpConfig();
      current.mcpServers = current.mcpServers || {};
      const targetName = newName && newName.trim() ? newName.trim() : originalName;
      if (targetName !== originalName) {
        delete current.mcpServers[originalName];
      }
      current.mcpServers[targetName] = validated;
      await writeMcpConfig(current);
      await notifyChange();
      return { ok: true };
    },

    async pi_mcp_remove({ name }) {
      const current = await readMcpConfig();
      if (current.mcpServers && current.mcpServers[name]) {
        delete current.mcpServers[name];
        await writeMcpConfig(current);
        await notifyChange();
      }
      return current;
    },

    async pi_mcp_test({ name }) {
      const current = await readMcpConfig();
      const server = current.mcpServers?.[name];
      if (!server) {
        return {
          ok: false,
          latencyMs: 0,
          message: `Server "${name}" not found in mcp.json`,
        };
      }
      return await testMcpServer(name, server);
    },

    async pi_mcp_update_settings(updates) {
      const current = await readMcpConfig();
      current.settings = { ...(current.settings || {}), ...updates };
      await writeMcpConfig(current);
      await notifyChange();
      return current;
    },
  });

  // --- CLI Commands ---
  bb.cli.register({
    name: "pi",
    summary: "Manage pi.dev configuration, settings.json, packages, and mcp.json",
    commands: [
      {
        name: "status",
        summary: "Show machine, pi directory, settings status, and active models",
        usage: "bb pi status",
      },
      {
        name: "config",
        summary: "View or set pi configuration keys",
        usage: "bb pi config [get [key] | set <key> <val>]",
      },
      {
        name: "mcp",
        summary: "Manage MCP servers (list, get, set, toggle, remove, test)",
        usage: "bb pi mcp [list [--json] | get <name> | set <name> ... | toggle <name> | enable <name> | disable <name> | remove <name> | test <name>]",
      },
      {
        name: "package",
        summary: "List, add, or remove pi packages",
        usage: "bb pi package [list | add <pkg> | remove <pkg>]",
      },
    ],
    async run(argv, ctx) {
      const sub = argv[0] || "status";

      if (sub === "status") {
        const [settings, mcp] = await Promise.all([readPiSettings(), readMcpConfig()]);
        const mcpCount = Object.keys(mcp.mcpServers || {}).length;
        const out = [
          `Machine:          ${os.hostname()}`,
          `Pi Directory:     ${getPiDir()}`,
          `Settings File:    ${getSettingsPath()}`,
          `MCP File:         ${getMcpPath()}`,
          `Default Provider: ${settings.defaultProvider || "(none)"}`,
          `Default Model:    ${settings.defaultModel || "(none)"}`,
          `Thinking Level:   ${settings.defaultThinkingLevel || "(none)"}`,
          `Installed Pkgs:   ${settings.packages?.length || 0}`,
          `MCP Servers:      ${mcpCount}`,
        ].join("\n");
        return { exitCode: 0, stdout: out };
      }

      if (sub === "config") {
        const action = argv[1] || "get";
        if (action === "get") {
          const key = argv[2];
          const settings = await readPiSettings();
          if (key) {
            const val = (settings as any)[key];
            return {
              exitCode: 0,
              stdout: val !== undefined ? (typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)) : `Key "${key}" not found`,
            };
          }
          return { exitCode: 0, stdout: JSON.stringify(settings, null, 2) };
        }
        if (action === "set") {
          const key = argv[2];
          const val = argv[3];
          if (!key || val === undefined) {
            return { exitCode: 1, stderr: "Usage: bb pi config set <key> <value>" };
          }
          const settings = await readPiSettings();
          let parsedVal: any = val;
          if (val === "true") parsedVal = true;
          else if (val === "false") parsedVal = false;
          else if (!Number.isNaN(Number(val)) && val.trim() !== "") parsedVal = Number(val);
          else {
            try {
              parsedVal = JSON.parse(val);
            } catch {}
          }
          (settings as any)[key] = parsedVal;
          await writePiSettings(settings);
          await notifyChange();
          return { exitCode: 0, stdout: `Set ${key} = ${JSON.stringify(parsedVal)}` };
        }
        return { exitCode: 1, stderr: `Unknown config action: ${action}. Use "get" or "set".` };
      }

      if (sub === "package") {
        const action = argv[1] || "list";
        const settings = await readPiSettings();
        if (action === "list") {
          const pkgs = settings.packages || [];
          if (pkgs.length === 0) return { exitCode: 0, stdout: "No packages installed in settings.json" };
          return { exitCode: 0, stdout: pkgs.map((p) => `- ${p}`).join("\n") };
        }
        if (action === "add") {
          const pkg = argv[2];
          if (!pkg) return { exitCode: 1, stderr: "Usage: bb pi package add <pkg>" };
          if (!settings.packages?.includes(pkg)) {
            settings.packages = [...(settings.packages || []), pkg];
            await writePiSettings(settings);
            await notifyChange();
          }
          return { exitCode: 0, stdout: `Added package ${pkg}` };
        }
        if (action === "remove") {
          const pkg = argv[2];
          if (!pkg) return { exitCode: 1, stderr: "Usage: bb pi package remove <pkg>" };
          settings.packages = (settings.packages || []).filter((p) => p !== pkg);
          await writePiSettings(settings);
          await notifyChange();
          return { exitCode: 0, stdout: `Removed package ${pkg}` };
        }
      }

      if (sub === "mcp") {
        const action = argv[1] || "list";
        const mcpConfig = await readMcpConfig();
        const servers = mcpConfig.mcpServers || {};

        if (action === "list") {
          if (argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(servers, null, 2) };
          }
          const names = Object.keys(servers);
          if (names.length === 0) {
            return { exitCode: 0, stdout: "No MCP servers configured in mcp.json" };
          }
          const lines = ["NAME               STATUS      TYPE        LIFECYCLE   URL / COMMAND"];
          lines.push("-".repeat(78));
          for (const name of names) {
            const s = servers[name];
            const statusStr = s.disabled ? "disabled" : "enabled";
            const type = s.type || (s.url ? "remote" : "local");
            const lc = s.lifecycle || "standard";
            const target = s.url || (Array.isArray(s.command) ? s.command.join(" ") : s.command) || "-";
            lines.push(
              `${name.padEnd(18)} ${statusStr.padEnd(11)} ${type.padEnd(11)} ${lc.padEnd(11)} ${target}`
            );
          }
          return { exitCode: 0, stdout: lines.join("\n") };
        }

        if (action === "get") {
          const name = argv[2];
          if (!name) return { exitCode: 1, stderr: "Usage: bb pi mcp get <name>" };
          const s = servers[name];
          if (!s) return { exitCode: 1, stderr: `MCP server "${name}" not found.` };
          return { exitCode: 0, stdout: JSON.stringify(s, null, 2) };
        }

        if (action === "enable" || action === "disable" || action === "toggle") {
          const name = argv[2];
          if (!name) return { exitCode: 1, stderr: `Usage: bb pi mcp ${action} <name>` };
          const s = servers[name];
          if (!s) return { exitCode: 1, stderr: `MCP server "${name}" not found.` };
          const willDisable = action === "disable" ? true : action === "enable" ? false : !s.disabled;
          if (willDisable) {
            s.disabled = true;
          } else {
            delete s.disabled;
          }
          await writeMcpConfig(mcpConfig);
          await notifyChange();
          return { exitCode: 0, stdout: `${willDisable ? "Disabled" : "Enabled"} MCP server "${name}".` };
        }

        if (action === "remove") {
          const name = argv[2];
          if (!name) return { exitCode: 1, stderr: "Usage: bb pi mcp remove <name>" };
          if (!servers[name]) return { exitCode: 1, stderr: `MCP server "${name}" not found.` };
          delete servers[name];
          await writeMcpConfig(mcpConfig);
          await notifyChange();
          return { exitCode: 0, stdout: `Removed MCP server "${name}".` };
        }

        if (action === "set") {
          const name = argv[2];
          if (!name) return { exitCode: 1, stderr: "Usage: bb pi mcp set <name> --url <url> ..." };
          let url: string | undefined;
          let type: string | undefined;
          let lifecycle: "eager" | "lazy" | undefined;
          let disabled: boolean | undefined;
          const headers: Record<string, string> = {};

          for (let i = 3; i < argv.length; i++) {
            if (argv[i] === "--url" && argv[i + 1]) {
              url = argv[++i];
            } else if (argv[i] === "--type" && argv[i + 1]) {
              type = argv[++i];
            } else if (argv[i] === "--lifecycle" && argv[i + 1]) {
              const val = argv[++i];
              if (val === "eager" || val === "lazy") lifecycle = val;
            } else if (argv[i] === "--disabled") {
              disabled = true;
            } else if (argv[i] === "--enabled") {
              disabled = false;
            } else if (argv[i] === "--header" && argv[i + 1]) {
              const pair = argv[++i];
              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                headers[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
              }
            }
          }

          const existing = servers[name] || {};
          const updated: McpServer = {
            ...existing,
            ...(url ? { url } : {}),
            ...(type ? { type } : {}),
            ...(lifecycle ? { lifecycle } : {}),
            ...(disabled !== undefined ? (disabled ? { disabled: true } : {}) : {}),
            ...(Object.keys(headers).length > 0 ? { headers: { ...(existing.headers || {}), ...headers } } : {}),
          };
          if (disabled === false) {
            delete updated.disabled;
          }

          servers[name] = updated;
          await writeMcpConfig(mcpConfig);
          await notifyChange();
          return { exitCode: 0, stdout: `Configured MCP server "${name}":\n${JSON.stringify(updated, null, 2)}` };
        }

        if (action === "test") {
          const name = argv[2];
          if (!name) return { exitCode: 1, stderr: "Usage: bb pi mcp test <name>" };
          const s = servers[name];
          if (!s) return { exitCode: 1, stderr: `MCP server "${name}" not found.` };
          const result = await testMcpServer(name, s);
          const statusStr = result.ok ? "✓ SUCCESS" : "✗ FAILED";
          return {
            exitCode: result.ok ? 0 : 1,
            stdout: `${statusStr}: ${result.message} (${result.latencyMs}ms)`,
          };
        }

        return { exitCode: 1, stderr: `Unknown mcp action: ${action}. Use list, get, set, enable, disable, toggle, remove, test.` };
      }

      return { exitCode: 1, stderr: `Unknown subcommand "${sub}". Run "bb pi status" or "bb pi --help".` };
    },
  });

  // --- Agent Tools ---
  if (false) bb.agents.registerTool({
    name: "pi_config_read",
    description: "Read pi.dev's settings.json and mcp.json configurations safely.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["all", "settings", "mcp"], default: "all" },
      },
    },
    async execute(args: any) {
      const target = args?.target || "all";
      if (target === "settings") {
        return JSON.stringify(await readPiSettings(), null, 2);
      }
      if (target === "mcp") {
        return JSON.stringify(await readMcpConfig(), null, 2);
      }
      const [settings, mcp] = await Promise.all([readPiSettings(), readMcpConfig()]);
      return JSON.stringify({ settings, mcp }, null, 2);
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_config_set",
    description: "Update pi.dev settings.json keys (such as defaultModel, defaultProvider, defaultThinkingLevel).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The setting key name, e.g. defaultModel, defaultProvider, defaultThinkingLevel" },
        value: { description: "The value to set" },
      },
      required: ["key", "value"],
    },
    async execute(args: any) {
      const key = args?.key;
      const value = args?.value;
      const settings = await readPiSettings();
      (settings as any)[key] = value;
      await writePiSettings(settings);
      await notifyChange();
      return `Updated settings.json: ${key} = ${JSON.stringify(value)}`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_mcp_list",
    description: "List all configured MCP servers and their transport/lifecycle in mcp.json.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const mcp = await readMcpConfig();
      return JSON.stringify(mcp.mcpServers || {}, null, 2);
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_mcp_set",
    description: "Add or update an MCP server in pi's mcp.json with automatic cache invalidation.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique identifier name for the MCP server" },
        url: { type: "string", description: "HTTP / SSE URL for remote MCP servers" },
        type: { type: "string", description: "Transport type: http, sse, stdio" },
        lifecycle: { type: "string", enum: ["eager", "lazy"] },
        disabled: { type: "boolean", description: "Whether the server is disabled" },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["name"],
    },
    async execute(args: any) {
      const { name, url, type, lifecycle, disabled, headers } = args || {};
      const mcp = await readMcpConfig();
      mcp.mcpServers = mcp.mcpServers || {};
      const existing = mcp.mcpServers[name] || {};
      const updated: McpServer = {
        ...existing,
        ...(url !== undefined ? { url } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(lifecycle !== undefined ? { lifecycle } : {}),
        ...(disabled !== undefined ? (disabled ? { disabled: true } : {}) : {}),
        ...(headers ? { headers: { ...(existing.headers || {}), ...headers } } : {}),
      };
      if (disabled === false) {
        delete updated.disabled;
      }
      mcp.mcpServers[name] = updated;
      await writeMcpConfig(mcp);
      await notifyChange();
      return `Successfully upserted MCP server "${name}":\n${JSON.stringify(updated, null, 2)}`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_mcp_toggle",
    description: "Enable or disable an MCP server in mcp.json without removing it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the MCP server" },
        disabled: { type: "boolean", description: "True to disable, false to enable" },
      },
      required: ["name", "disabled"],
    },
    async execute(args: any) {
      const { name, disabled } = args || {};
      const mcp = await readMcpConfig();
      if (!mcp.mcpServers?.[name]) {
        return `MCP server "${name}" was not found in mcp.json`;
      }
      if (disabled) {
        mcp.mcpServers[name].disabled = true;
      } else {
        delete mcp.mcpServers[name].disabled;
      }
      await writeMcpConfig(mcp);
      await notifyChange();
      return `MCP server "${name}" is now ${disabled ? "disabled" : "enabled"}.`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_mcp_remove",
    description: "Remove an MCP server from pi's mcp.json.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the MCP server to remove" },
      },
      required: ["name"],
    },
    async execute(args: any) {
      const name = args?.name;
      const mcp = await readMcpConfig();
      if (!mcp.mcpServers?.[name]) {
        return `MCP server "${name}" was not found in mcp.json`;
      }
      delete mcp.mcpServers[name];
      await writeMcpConfig(mcp);
      await notifyChange();
      return `Successfully removed MCP server "${name}" from mcp.json`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "pi_mcp_test",
    description: "Test network reachability and HTTP handshake for an MCP server in mcp.json.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the MCP server to test" },
      },
      required: ["name"],
    },
    async execute(args: any) {
      const name = args?.name;
      const mcp = await readMcpConfig();
      const server = mcp.mcpServers?.[name];
      if (!server) {
        return `Error: MCP server "${name}" not found in mcp.json`;
      }
      const res = await testMcpServer(name, server);
      return JSON.stringify(res, null, 2);
    },
  });

  bb.agents.configure(() => ({
    tools: [
      // Agent tools intentionally disabled to avoid injecting management tools into model context.
      ...[],
    ],
    skills: [],
  }));
}
