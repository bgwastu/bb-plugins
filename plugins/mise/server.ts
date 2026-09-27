import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./contract";
import {
  execMise,
  getDoctor,
  getEnv,
  getMiseBin,
  getMiseVersion,
  getStatus,
  getUniverseRoot,
  installTool,
  invalidateCache,
  listOutdated,
  listTasks,
  listTools,
  readConfigFile,
  runMiseStreaming,
  searchRegistry,
  uninstallTool,
  upgradeTools,
  useTool,
  writeConfigFile,
} from "./lib/mise";
import {
  MISE_STATE_CHANGED,
  MISE_UPGRADE_EVENT,
  miseOutdatedItemSchema,
  miseStatusSchema,
  miseTaskItemSchema,
  miseToolItemSchema,
  upgradeJobSchema,
  type MiseOutdatedItem,
  type MiseStatus,
  type MiseTaskItem,
  type MiseToolItem,
  type UpgradeJob,
} from "./lib/types";

export const miseMachineSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  isServer: z.boolean(),
});
export type MiseMachine = z.infer<typeof miseMachineSchema>;

const hostInputSchema = z
  .object({
    hostId: z.string().optional(),
    forceRefresh: z.boolean().optional(),
  })
  .nullish();

export const rpcContract = defineRpcContract({
  mise_list_machines: {
    input: z.null(),
    output: z.array(miseMachineSchema),
  },
  mise_get_status: {
    input: hostInputSchema,
    output: miseStatusSchema,
  },
  mise_list_tools: {
    input: hostInputSchema,
    output: z.array(miseToolItemSchema),
  },
  mise_list_outdated: {
    input: hostInputSchema,
    output: z.array(miseOutdatedItemSchema),
  },
  mise_list_tasks: {
    input: hostInputSchema,
    output: z.array(miseTaskItemSchema),
  },
  mise_get_env: {
    input: hostInputSchema,
    output: z.record(z.string(), z.string()),
  },
  mise_search_tools: {
    input: z.object({
      query: z.string().min(1),
      hostId: z.string().optional(),
    }),
    output: z.array(z.object({ name: z.string(), description: z.string() })),
  },
  mise_install_tool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().optional(),
      hostId: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  mise_uninstall_tool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().min(1),
      hostId: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  mise_use_tool: {
    input: z.object({
      tool: z.string().min(1),
      version: z.string().min(1),
      hostId: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  mise_upgrade_tools: {
    input: z.object({
      tools: z.array(z.string()).optional(),
      hostId: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      upgraded: z.array(z.string()),
    }),
  },
  mise_start_upgrade: {
    input: z.object({
      tools: z.array(z.string()).optional(),
      hostId: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      jobId: z.string(),
      message: z.string().optional(),
    }),
  },
  mise_get_active_upgrade: {
    input: hostInputSchema,
    output: upgradeJobSchema.nullable(),
  },
  mise_clear_upgrade: {
    input: hostInputSchema,
    output: z.object({ ok: z.boolean() }),
  },
  mise_run_task_terminal: {
    input: z.object({
      task: z.string().min(1),
      hostId: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      terminalId: z.string().optional(),
      message: z.string().optional(),
    }),
  },
  mise_read_config: {
    input: z.object({
      filePath: z.string().min(1),
      hostId: z.string().optional(),
    }),
    output: z.object({ content: z.string() }),
  },
  mise_write_config: {
    input: z.object({
      filePath: z.string().min(1),
      content: z.string(),
      hostId: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const hostClient = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  interface HostCacheItem {
    status?: { data: MiseStatus; time: number };
    tools?: { data: MiseToolItem[]; time: number };
    outdated?: { data: MiseOutdatedItem[]; time: number };
    tasks?: { data: MiseTaskItem[]; time: number };
    env?: { data: Record<string, string>; time: number };
  }

  const serverCache = new Map<string, HostCacheItem>();
  const activeUpgradeJobs = new Map<string, UpgradeJob>();

  hostClient.experimental_onSignal("upgradeLog", ({ hostId, payload }) => {
    const job = activeUpgradeJobs.get(hostId);
    if (job && job.id === payload.jobId) {
      job.logs.push(payload.line);
      bb.realtime.publish(MISE_UPGRADE_EVENT, {
        hostId,
        jobId: payload.jobId,
        line: payload.line,
        status: job.status,
      });
    }
  });

  const getHostCache = (hostId: string): HostCacheItem => {
    let item = serverCache.get(hostId);
    if (!item) {
      item = {};
      serverCache.set(hostId, item);
    }
    return item;
  };

  const invalidateServerCache = (hostId?: string) => {
    if (hostId) {
      serverCache.delete(hostId);
    } else {
      serverCache.clear();
    }
  };

  const notifyChange = async () => {
    invalidateServerCache();
    try {
      bb.realtime.publish(MISE_STATE_CHANGED, { at: Date.now() });
    } catch {}
  };

  async function resolveTargetHost(targetHostId?: string | null): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    if (targetHostId) {
      const found = hosts.find(
        (h) => h.id === targetHostId || h.name.toLowerCase() === targetHostId.toLowerCase(),
      );
      if (found) return found.id;
    }
    const serverHost = hosts.find(
      (h) => (h as any).role === "server" || (h as any).isServer === true,
    );
    if (serverHost) return serverHost.id;
    const connected = hosts.find((h) => h.status === "connected");
    if (connected) return connected.id;
    return hosts[0]?.id || "local";
  }

  async function isLocalServer(hostId: string): Promise<boolean> {
    const hosts = await bb.sdk.hosts.list();
    const target = hosts.find((h) => h.id === hostId);
    if (!target) return true;
    return (target as any).role === "server" || (target as any).isServer === true;
  }

  async function execOnHost<T>(
    hostIdParam: string | undefined | null,
    remoteCall: (targetHostId: string) => Promise<T>,
    localFallback: () => Promise<T>,
  ): Promise<T> {
    const targetHostId = await resolveTargetHost(hostIdParam);
    try {
      return await remoteCall(targetHostId);
    } catch (err: any) {
      if (await isLocalServer(targetHostId)) {
        return await localFallback();
      }
      throw err;
    }
  }

  // Implement RPC for Frontend
  bb.rpc.register(rpcContract, {
    async mise_list_machines() {
      const hosts = await bb.sdk.hosts.list();
      return hosts.map((h) => ({
        id: h.id,
        name: h.name,
        status: h.status,
        isServer: (h as any).role === "server" || (h as any).isServer === true,
      }));
    },
    async mise_get_status(input) {
      const target = await resolveTargetHost(input?.hostId);
      const cache = getHostCache(target);
      if (!input?.forceRefresh && cache.status && Date.now() - cache.status.time < 30_000) {
        return cache.status.data;
      }
      const data = await execOnHost(
        target,
        (h) => hostClient.call("getStatus", { forceRefresh: input?.forceRefresh }, { hostId: h }),
        () => getStatus(input?.forceRefresh),
      );
      cache.status = { data, time: Date.now() };
      return data;
    },
    async mise_list_tools(input) {
      const target = await resolveTargetHost(input?.hostId);
      const cache = getHostCache(target);
      if (!input?.forceRefresh && cache.tools && Date.now() - cache.tools.time < 30_000) {
        return cache.tools.data;
      }
      const data = await execOnHost(
        target,
        (h) => hostClient.call("listTools", { forceRefresh: input?.forceRefresh }, { hostId: h }),
        () => listTools(input?.forceRefresh),
      );
      cache.tools = { data, time: Date.now() };
      return data;
    },
    async mise_list_outdated(input) {
      const target = await resolveTargetHost(input?.hostId);
      const cache = getHostCache(target);
      if (!input?.forceRefresh && cache.outdated && Date.now() - cache.outdated.time < 60_000) {
        return cache.outdated.data;
      }
      const data = await execOnHost(
        target,
        (h) => hostClient.call("listOutdated", { forceRefresh: input?.forceRefresh }, { hostId: h }),
        () => listOutdated(input?.forceRefresh),
      );
      cache.outdated = { data, time: Date.now() };
      return data;
    },
    async mise_list_tasks(input) {
      const target = await resolveTargetHost(input?.hostId);
      const cache = getHostCache(target);
      if (!input?.forceRefresh && cache.tasks && Date.now() - cache.tasks.time < 45_000) {
        return cache.tasks.data;
      }
      const data = await execOnHost(
        target,
        (h) => hostClient.call("listTasks", { forceRefresh: input?.forceRefresh }, { hostId: h }),
        () => listTasks(input?.forceRefresh),
      );
      cache.tasks = { data, time: Date.now() };
      return data;
    },
    async mise_get_env(input) {
      const target = await resolveTargetHost(input?.hostId);
      const cache = getHostCache(target);
      if (!input?.forceRefresh && cache.env && Date.now() - cache.env.time < 60_000) {
        return cache.env.data;
      }
      const data = await execOnHost(
        target,
        (h) => hostClient.call("getEnv", { forceRefresh: input?.forceRefresh }, { hostId: h }),
        () => getEnv(input?.forceRefresh),
      );
      cache.env = { data, time: Date.now() };
      return data;
    },
    async mise_search_tools({ query, hostId }) {
      return await execOnHost(
        hostId,
        (h) => hostClient.call("searchTools", { query }, { hostId: h }),
        () => searchRegistry(query),
      );
    },
    async mise_install_tool({ tool, version, hostId }) {
      const res = await execOnHost(
        hostId,
        (h) => hostClient.call("installTool", { tool, version }, { hostId: h }),
        () => installTool(tool, version),
      );
      if (res.ok) await notifyChange();
      return res;
    },
    async mise_uninstall_tool({ tool, version, hostId }) {
      const res = await execOnHost(
        hostId,
        (h) => hostClient.call("uninstallTool", { tool, version }, { hostId: h }),
        () => uninstallTool(tool, version),
      );
      if (res.ok) await notifyChange();
      return res;
    },
    async mise_use_tool({ tool, version, hostId }) {
      const res = await execOnHost(
        hostId,
        (h) => hostClient.call("useTool", { tool, version }, { hostId: h }),
        () => useTool(tool, version),
      );
      if (res.ok) await notifyChange();
      return res;
    },
    async mise_upgrade_tools({ tools, hostId }) {
      const res = await execOnHost(
        hostId,
        (h) => hostClient.call("upgradeTools", tools && tools.length > 0 ? { tools } : {}, { hostId: h }),
        () => upgradeTools(tools),
      );
      if (res.ok) await notifyChange();
      return res;
    },
    async mise_start_upgrade({ tools, hostId }) {
      const targetHostId = await resolveTargetHost(hostId);
      const jobId = "upg_" + Math.random().toString(36).slice(2, 9);
      const listStr = tools && tools.length > 0 ? tools.join(", ") : "all packages";

      const job: UpgradeJob = {
        id: jobId,
        hostId: targetHostId,
        tools,
        status: "running",
        logs: [`[mise] Starting upgrade for ${listStr}...`],
        startedAt: Date.now(),
      };
      activeUpgradeJobs.set(targetHostId, job);

      bb.realtime.publish(MISE_UPGRADE_EVENT, {
        hostId: targetHostId,
        jobId,
        line: job.logs[0],
        status: "running",
      });

      // Execute asynchronously in the background so the RPC returns immediately
      void (async () => {
        try {
          const res = await execOnHost(
            targetHostId,
            (h) => hostClient.call("startUpgrade", { jobId, ...(tools && tools.length > 0 ? { tools } : {}) }, { hostId: h }),
            async () => {
              invalidateCache();
              const args = ["upgrade", "-y", ...(tools && tools.length > 0 ? tools : [])];
              const r = await runMiseStreaming(args, (line) => {
                job.logs.push(line);
                bb.realtime.publish(MISE_UPGRADE_EVENT, {
                  hostId: targetHostId,
                  jobId,
                  line,
                  status: "running",
                });
              });
              invalidateCache();
              return {
                ok: r.exitCode === 0,
                message: r.exitCode === 0 ? "Upgrade completed successfully" : (r.error || "Upgrade failed"),
              };
            },
          );
          job.status = res.ok ? "completed" : "failed";
          job.completedAt = Date.now();
          job.message = res.message;
          job.logs.push(`[mise] ${res.message}`);
        } catch (err: any) {
          job.status = "failed";
          job.completedAt = Date.now();
          job.error = err.message || String(err);
          job.logs.push(`[mise] Error: ${job.error}`);
        } finally {
          invalidateServerCache(targetHostId);
          bb.realtime.publish(MISE_UPGRADE_EVENT, {
            hostId: targetHostId,
            jobId,
            status: job.status,
            message: job.message || job.error,
          });
          void notifyChange();
        }
      })();

      return { ok: true, jobId };
    },
    async mise_get_active_upgrade(input) {
      const targetHostId = await resolveTargetHost(input?.hostId);
      const job = activeUpgradeJobs.get(targetHostId);
      return job ?? null;
    },
    async mise_clear_upgrade(input) {
      const targetHostId = await resolveTargetHost(input?.hostId);
      activeUpgradeJobs.delete(targetHostId);
      return { ok: true };
    },
    async mise_run_task_terminal({ task, hostId }) {
      try {
        const targetHostId = await resolveTargetHost(hostId);
        let universeRoot = getUniverseRoot();
        try {
          const rootRes = await hostClient.call("getUniverseRoot", null, { hostId: targetHostId });
          if (rootRes?.path) universeRoot = rootRes.path;
        } catch {}

        const term = await bb.sdk.terminals.create({
          cols: 100,
          rows: 30,
          scope: { kind: "host_path", hostId: targetHostId, cwd: universeRoot },
          start: { mode: "command", command: `mise run ${task}` },
          title: `mise run ${task}`,
        });

        return { ok: true, terminalId: term.id };
      } catch (err: any) {
        return { ok: false, message: err.message || String(err) };
      }
    },
    async mise_read_config({ filePath, hostId }) {
      return await execOnHost(
        hostId,
        async (h) => await hostClient.call("readConfig", { filePath }, { hostId: h }),
        async () => ({ content: await readConfigFile(filePath) }),
      );
    },
    async mise_write_config({ filePath, content, hostId }) {
      const res = await execOnHost(
        hostId,
        (h) => hostClient.call("writeConfig", { filePath, content }, { hostId: h }),
        () => writeConfigFile(filePath, content),
      );
      if (res.ok) await notifyChange();
      return res;
    },
  });

  function parseMachineArg(argv: string[]): { machine: string | null; cleanArgv: string[] } {
    let machine: string | null = null;
    const cleanArgv: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--machine" || argv[i] === "--host") {
        machine = argv[i + 1] || null;
        i++;
      } else if (argv[i].startsWith("--machine=")) {
        machine = argv[i].slice("--machine=".length);
      } else if (argv[i].startsWith("--host=")) {
        machine = argv[i].slice("--host=".length);
      } else {
        cleanArgv.push(argv[i]);
      }
    }
    return { machine, cleanArgv };
  }

  // CLI Command: bb mise ...
  bb.cli.register({
    name: "mise",
    summary: "Manage mise toolchains, runtimes, tasks, and harness updates across the fleet",
    commands: [
      {
        name: "status",
        summary: "Show machine, mise version, doctor health, and runtime count",
        usage: "bb mise status [--machine <id-or-name>]",
      },
      {
        name: "machines",
        summary: "List all enrolled BB machines and their status",
        usage: "bb mise machines [--json]",
      },
      {
        name: "ls",
        summary: "List installed and active tools",
        usage: "bb mise ls [--machine <id-or-name>] [--json]",
      },
      {
        name: "outdated",
        summary: "List outdated tool versions",
        usage: "bb mise outdated [--machine <id-or-name>] [--json]",
      },
      {
        name: "update",
        summary: "Upgrade tools via mise (handles bb-app, pi, opencode)",
        usage: "bb mise update [tools...] [--machine <id-or-name>]",
      },
      {
        name: "install",
        summary: "Install a tool version",
        usage: "bb mise install <tool>[@version] [--machine <id-or-name>]",
      },
      {
        name: "use",
        summary: "Pin a tool version globally",
        usage: "bb mise use <tool>@<version> [--machine <id-or-name>]",
      },
      {
        name: "tasks",
        summary: "List available fleet tasks",
        usage: "bb mise tasks [--machine <id-or-name>] [--json]",
      },
      {
        name: "run",
        summary: "Run a mise task",
        usage: "bb mise run <task> [args...] [--machine <id-or-name>]",
      },
      {
        name: "env",
        summary: "View active mise environment variables",
        usage: "bb mise env [--machine <id-or-name>] [--json]",
      },
      {
        name: "doctor",
        summary: "Run mise doctor diagnostics",
        usage: "bb mise doctor [--machine <id-or-name>]",
      },
    ],
    async run(argv) {
      const { machine, cleanArgv } = parseMachineArg(argv);
      const sub = cleanArgv[0] || "status";

      if (sub === "machines") {
        const hosts = await bb.sdk.hosts.list();
        const json = cleanArgv.includes("--json");
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(hosts, null, 2) };
        }
        const lines = hosts.map((h) => {
          const isServer = (h as any).role === "server" ? " [server]" : "";
          return `• ${h.name} (${h.id})${isServer} - ${h.status}`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (sub === "status") {
        const s = await execOnHost(
          machine,
          (h) => hostClient.call("getStatus", null, { hostId: h }),
          () => getStatus(),
        );
        const out = [
          `Machine:         ${s.machine}`,
          `Mise Version:    ${s.miseVersion}`,
          `Mise Binary:     ${s.miseBin}`,
          `Installed Tools: ${s.toolsCount}`,
          `Outdated Tools:  ${s.outdatedCount}`,
          `Available Tasks: ${s.tasksCount}`,
          `Doctor Health:   ${s.doctor.problems.length === 0 ? "✓ Healthy" : `✗ Problems (${s.doctor.problems.length})`}`,
          `Shims on PATH:   ${s.doctor.shimsOnPath ? "Yes" : "No"}`,
          `Self-Update:     ${s.doctor.selfUpdateAvailable ? "Available" : "Up to date"}`,
        ].join("\n");
        return { exitCode: 0, stdout: out };
      }

      if (sub === "ls" || sub === "list") {
        const json = cleanArgv.includes("--json");
        const tools = await execOnHost(
          machine,
          (h) => hostClient.call("listTools", null, { hostId: h }),
          () => listTools(),
        );
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(tools, null, 2) };
        }
        if (tools.length === 0) {
          return { exitCode: 0, stdout: "No tools installed." };
        }
        const lines = tools.map((t) => {
          const active = t.activeVersion ? `@${t.activeVersion}` : "(none)";
          const outdated = t.isOutdated ? ` -> ${t.latestVersion} (outdated)` : "";
          return `• ${t.name}${active}${outdated}`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (sub === "outdated") {
        const json = cleanArgv.includes("--json");
        const items = await execOnHost(
          machine,
          (h) => hostClient.call("listOutdated", null, { hostId: h }),
          () => listOutdated(),
        );
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(items, null, 2) };
        }
        if (items.length === 0) {
          return { exitCode: 0, stdout: "Everything is up to date." };
        }
        const lines = items.map((i) => {
          return `• ${i.name}: ${i.current} -> ${i.latest} (requested: ${i.requested})`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (sub === "update" || sub === "upgrade") {
        const targets = cleanArgv.slice(1).filter((a) => !a.startsWith("-"));
        const res = await execOnHost(
          machine,
          (h) => hostClient.call("upgradeTools", { tools: targets.length > 0 ? targets : undefined }, { hostId: h }),
          () => upgradeTools(targets.length > 0 ? targets : undefined),
        );
        await notifyChange();
        if (!res.ok) {
          return { exitCode: 1, stderr: res.message };
        }
        return { exitCode: 0, stdout: res.message };
      }

      if (sub === "install") {
        const target = cleanArgv[1];
        if (!target) {
          return { exitCode: 1, stderr: "Usage: bb mise install <tool>[@version]" };
        }
        const [tool, version] = target.split("@");
        const res = await execOnHost(
          machine,
          (h) => hostClient.call("installTool", { tool, version }, { hostId: h }),
          () => installTool(tool, version),
        );
        await notifyChange();
        if (!res.ok) {
          return { exitCode: 1, stderr: res.message };
        }
        return { exitCode: 0, stdout: res.message };
      }

      if (sub === "use") {
        const target = cleanArgv[1];
        if (!target || !target.includes("@")) {
          return { exitCode: 1, stderr: "Usage: bb mise use <tool>@<version>" };
        }
        const [tool, version] = target.split("@");
        const res = await execOnHost(
          machine,
          (h) => hostClient.call("useTool", { tool, version }, { hostId: h }),
          () => useTool(tool, version),
        );
        await notifyChange();
        if (!res.ok) {
          return { exitCode: 1, stderr: res.message };
        }
        return { exitCode: 0, stdout: res.message };
      }

      if (sub === "tasks") {
        const json = cleanArgv.includes("--json");
        const tasks = await execOnHost(
          machine,
          (h) => hostClient.call("listTasks", null, { hostId: h }),
          () => listTasks(),
        );
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(tasks, null, 2) };
        }
        if (tasks.length === 0) {
          return { exitCode: 0, stdout: "No tasks configured in mise.toml" };
        }
        const lines = tasks.map((t) => {
          const desc = t.description ? ` - ${t.description}` : "";
          return `• ${t.name}${desc} [${t.run.join(" && ")}]`;
        });
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (sub === "run") {
        const taskName = cleanArgv[1];
        if (!taskName) {
          return { exitCode: 1, stderr: "Usage: bb mise run <task> [args...]" };
        }
        const passArgs = cleanArgv.slice(2);
        const res = await execOnHost(
          machine,
          (h) => hostClient.call("runTask", { task: taskName, args: passArgs }, { hostId: h }),
          () => execMise(["run", taskName, ...passArgs], 600_000),
        );
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        };
      }

      if (sub === "env") {
        const json = cleanArgv.includes("--json");
        const envVars = await execOnHost(
          machine,
          (h) => hostClient.call("getEnv", null, { hostId: h }),
          () => getEnv(),
        );
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify(envVars, null, 2) };
        }
        const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      if (sub === "doctor") {
        const doc = await execOnHost(
          machine,
          (h) => hostClient.call("getDoctor", null, { hostId: h }),
          () => getDoctor(),
        );
        const lines = [
          `Mise Doctor Diagnostics`,
          `-----------------------`,
          `Version:         ${doc.version}`,
          `Activated:       ${doc.activated ? "Yes" : "No"}`,
          `Shims on PATH:   ${doc.shimsOnPath ? "Yes" : "No"}`,
          `Self-Update:     ${doc.selfUpdateAvailable ? "Available (run mise self-update)" : "Up to date"}`,
          `Warnings:        ${doc.warnings.length > 0 ? doc.warnings.join("\n") : "None"}`,
          `Problems:        ${doc.problems.length > 0 ? doc.problems.join("\n") : "No problems found"}`,
        ];
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      return {
        exitCode: 1,
        stderr: `Unknown subcommand "${sub}". Run "bb mise --help" for available commands.`,
      };
    },
  });

  // Native Agent Tools (Global)
  if (false) bb.agents.registerTool({
    name: "mise_list_tools",
    description: "List all active and installed toolchains, compilers, runtimes, and their versions via mise. Supports targeting a specific machine/worker.",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Optional machine name or ID (e.g. 'Air', 'artemis'). Defaults to the primary server." },
      },
    },
    async execute(args: any) {
      const { machine } = args || {};
      const tools = await execOnHost(
        machine,
        (h) => hostClient.call("listTools", null, { hostId: h }),
        () => listTools(),
      );
      return JSON.stringify(tools, null, 2);
    },
  });

  if (false) bb.agents.registerTool({
    name: "mise_install_tool",
    description: "Install a specific runtime or tool version using mise (e.g. node@22.0.0, python@3.12, bun@latest). Supports targeting a specific machine/worker.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The name of the tool (e.g. node, python, bun, go, uv)" },
        version: { type: "string", description: "Optional version to install (e.g. 22.0.0, latest). If omitted, installs config version." },
        machine: { type: "string", description: "Optional machine name or ID (e.g. 'Air', 'artemis'). Defaults to the primary server." },
      },
      required: ["tool"],
    },
    async execute(args: any) {
      const { tool, version, machine } = args || {};
      const res = await execOnHost(
        machine,
        (h) => hostClient.call("installTool", { tool, version }, { hostId: h }),
        () => installTool(tool, version),
      );
      await notifyChange();
      return res.ok ? res.message : `Error: ${res.message}`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "mise_use_tool",
    description: "Set and pin a tool version globally via mise. Supports targeting a specific machine/worker.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The name of the tool (e.g. node, python, bun)" },
        version: { type: "string", description: "The version to pin (e.g. 22, 3.12, latest)" },
        machine: { type: "string", description: "Optional machine name or ID (e.g. 'Air', 'artemis'). Defaults to the primary server." },
      },
      required: ["tool", "version"],
    },
    async execute(args: any) {
      const { tool, version, machine } = args || {};
      const res = await execOnHost(
        machine,
        (h) => hostClient.call("useTool", { tool, version }, { hostId: h }),
        () => useTool(tool, version),
      );
      await notifyChange();
      return res.ok ? res.message : `Error: ${res.message}`;
    },
  });

  if (false) bb.agents.registerTool({
    name: "mise_run_task",
    description: "Run a predefined mise task (e.g. build, test, setup, sync) and capture its output. Supports targeting a specific machine/worker.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task name defined in mise.toml" },
        args: { type: "array", items: { type: "string" }, description: "Optional extra arguments for the task" },
        machine: { type: "string", description: "Optional machine name or ID (e.g. 'Air', 'artemis'). Defaults to the primary server." },
      },
      required: ["task"],
    },
    async execute(args: any) {
      const { task, args: taskArgs, machine } = args || {};
      const runArgs = ["run", task, ...(taskArgs || [])];
      const res = await execOnHost(
        machine,
        (h) => hostClient.call("runTask", { task, args: taskArgs }, { hostId: h }),
        () => execMise(runArgs, 300_000),
      );
      return JSON.stringify(
        {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
        },
        null,
        2,
      );
    },
  });

  if (false) bb.agents.registerTool({
    name: "mise_get_env",
    description: "Export the full environment variables dictionary configured by mise. Supports targeting a specific machine/worker.",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Optional machine name or ID (e.g. 'Air', 'artemis'). Defaults to the primary server." },
      },
    },
    async execute(args: any) {
      const { machine } = args || {};
      const envVars = await execOnHost(
        machine,
        (h) => hostClient.call("getEnv", null, { hostId: h }),
        () => getEnv(),
      );
      return JSON.stringify(envVars, null, 2);
    },
  });
}
