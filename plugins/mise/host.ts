import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract";
import {
  execMise,
  getDoctor,
  getEnv,
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

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    getStatus: (input) => getStatus(input?.forceRefresh),
    listTools: (input) => listTools(input?.forceRefresh),
    listOutdated: (input) => listOutdated(input?.forceRefresh),
    listTasks: (input) => listTasks(input?.forceRefresh),
    getEnv: (input) => getEnv(input?.forceRefresh),
    searchTools: ({ query }) => searchRegistry(query),
    installTool: ({ tool, version }) => installTool(tool, version),
    uninstallTool: ({ tool, version }) => uninstallTool(tool, version),
    useTool: ({ tool, version }) => useTool(tool, version),
    upgradeTools: ({ tools }) => upgradeTools(tools),
    startUpgrade: async ({ jobId, tools }, context) => {
      invalidateCache();
      const lease = context.experimental_retainWorker();
      try {
        const args = ["upgrade", "-y", ...(tools && tools.length > 0 ? tools : [])];
        const res = await runMiseStreaming(args, async (line) => {
          try {
            await context.experimental_emitSignal("upgradeLog", { jobId, line });
          } catch {}
        });
        invalidateCache();
        return {
          ok: res.exitCode === 0,
          message: res.exitCode === 0 ? "Upgrade completed successfully" : (res.error || "Upgrade failed"),
        };
      } finally {
        await lease.dispose();
      }
    },
    readConfig: async ({ filePath }) => ({ content: await readConfigFile(filePath) }),
    writeConfig: ({ filePath, content }) => writeConfigFile(filePath, content),
    getDoctor: () => getDoctor(),
    runTask: async ({ task, args }) => {
      const runArgs = ["run", task, ...(args || [])];
      return await execMise(runArgs, 300_000);
    },
    getUniverseRoot: () => ({ path: getUniverseRoot() }),
  },
});
