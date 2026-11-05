import type { PaseoApi } from "@getpaseo/client";
import type { PluginRpcContract, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  catalogRpc,
  dirInfoRpc,
  defaultsWriteRpc,
  doctorRpc,
  extensionsInfoRpc,
  extensionsListRpc,
  extensionsRunRpc,
  extensionsSearchRpc,
  modelsRpc,
  overviewRpc,
  runControlRpc,
  runFilesRpc,
  runGetRpc,
  runOutputRpc,
  runsListRpc,
  runStartRpc,
  runSteerRpc,
  sessionsListRpc,
  sessionsPruneRpc,
  sessionsRemoveRpc,
  settingsReadRpc,
  settingsWriteRpc,
  statsRpc,
  updateRpc,
  usageRpc,
  workflowDeleteRpc,
  workflowDraftRpc,
  workflowGetRpc,
  workflowSaveRpc,
  workflowsListRpc,
} from "../shared/contracts";
import {
  doctor,
  extensionInfo,
  listExtensions,
  listSessions,
  models,
  pruneSessions,
  readSettings,
  readSettingsObject,
  removeSessions,
  runExtension,
  searchExtensions,
  stats,
  update,
  usage,
  writeDefaults,
  writeSettings,
} from "./manage";
import { agentDir, piBinary, piVersion } from "./pi";
import { activeCounts, controlRun, getRun, listRuns, runFiles, runOutput, startRunRpc, steerRun, workflowsExtension } from "./runs";
import { agentStatus, statusSummary, stopTask, taskLog } from "./status";
import { dirInfo } from "./where";
import { agentStatusRpc, statusSummaryRpc, taskLogRpc, taskStopRpc } from "../shared/status";
import { catalog, deleteWorkflow, draftWorkflow, getWorkflow, listWorkflows, saveWorkflowRpc } from "./workflows";

async function overview(_input: RpcInput<typeof overviewRpc>): Promise<RpcOutput<typeof overviewRpc>> {
  const path = piBinary();
  let version: string | null = null;
  let error: string | null = path ? null : "pi was not found. Set its path in the plugin settings.";
  if (path) {
    try {
      version = await piVersion();
      if (!version) error = `${path} --version failed`;
    } catch (cause) {
      error = (cause as Error).message;
    }
  }
  let defaults = { provider: null as string | null, model: null as string | null, thinking: null as string | null };
  try {
    const settings = await readSettingsObject("global");
    const read = (key: string) => (typeof settings[key] === "string" ? (settings[key] as string) : null);
    defaults = { provider: read("defaultProvider"), model: read("defaultModel"), thinking: read("defaultThinkingLevel") };
  } catch {
    // An unreadable settings.json shows no defaults; doctor names the problem.
  }
  const extension = await workflowsExtension();
  return {
    pi: { path, version, error },
    agentDir: agentDir(),
    defaults,
    workflows: {
      installed: extension.installed,
      version: extension.version,
      runner: extension.runner ? [extension.runner.command, ...extension.runner.args].join(" ") : null,
      error: extension.error,
    },
    runs: await activeCounts(),
    pid: process.pid,
  };
}

/**
 * Registers every RPC. `remember` keeps the daemon session of the handler context: it lives as
 * long as the plugin process, and the run watcher uses it to report run ends to agents.
 */
export function registerHandlers(server: PluginServerContext, remember: (paseo: PaseoApi) => void): void {
  const handle = <I extends ZodType, O extends ZodType>(
    contract: PluginRpcContract<I, O>,
    handler: (input: ZodOutput<I>, paseo: PaseoApi) => ZodInput<O> | Promise<ZodInput<O>>,
  ) => {
    server.handle(contract, (input, context) => {
      remember(context.paseo);
      return handler(input, context.paseo);
    });
  };

  handle(overviewRpc, overview);
  handle(doctorRpc, doctor);
  handle(updateRpc, update);
  handle(modelsRpc, models);
  handle(settingsReadRpc, readSettings);
  handle(settingsWriteRpc, writeSettings);
  handle(defaultsWriteRpc, writeDefaults);
  handle(sessionsListRpc, listSessions);
  handle(sessionsRemoveRpc, removeSessions);
  handle(sessionsPruneRpc, pruneSessions);
  handle(statsRpc, stats);
  handle(dirInfoRpc, dirInfo);
  handle(statusSummaryRpc, (_input, paseo) => statusSummary(paseo));
  handle(agentStatusRpc, (input, paseo) => agentStatus(input, paseo));
  handle(taskLogRpc, taskLog);
  handle(taskStopRpc, stopTask);
  handle(usageRpc, usage);

  handle(extensionsListRpc, listExtensions);
  handle(extensionsSearchRpc, searchExtensions);
  handle(extensionsInfoRpc, extensionInfo);
  handle(extensionsRunRpc, runExtension);

  handle(workflowsListRpc, listWorkflows);
  handle(workflowGetRpc, getWorkflow);
  handle(workflowSaveRpc, saveWorkflowRpc);
  handle(workflowDeleteRpc, deleteWorkflow);
  handle(catalogRpc, catalog);
  handle(workflowDraftRpc, draftWorkflow);

  handle(runsListRpc, listRuns);
  handle(runGetRpc, getRun);
  handle(runOutputRpc, runOutput);
  handle(runFilesRpc, runFiles);
  handle(runStartRpc, (input, paseo) => startRunRpc(input, paseo));
  handle(runControlRpc, async ({ id, action, decision }) => ({
    message: await controlRun(id, action, decision),
  }));
  handle(runSteerRpc, async ({ id, message }) => ({ message: await steerRun(id, message) }));
}
