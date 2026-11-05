// Tools for Paseo agents: the actions of pi's own `workflow` tool, and extension management.
import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { EXTENSION_ACTIONS } from "../shared/contracts";
import { isActive, statusLabel } from "../shared/runs";
import { formatDuration, normalizeWorkflow, parseWorkflow, resolveAskModels, slug, workflowInputs } from "../shared/workflow";
import { runExtensionCommand } from "./extensions";
import { extensionCommand, extensionInfo, listExtensions, searchExtensions } from "./manage";
import { appendRunCard, controlRun, getRun, listRuns, startRun, steerRun } from "./runs";
import { currentSettings } from "./pi";
import { createRunWorktree } from "./where";
import { deleteWorkflow, findWorkflow, getWorkflow, loadWorkflows, saveWorkflow } from "./workflows";

const WORKFLOW_ACTIONS = [
  "list",
  "get",
  "save",
  "delete",
  "run",
  "status",
  "stop",
  "resume",
  "skip_wait",
  "message",
  "background",
  "foreground",
] as const;

const workflowInput = z.object({
  action: z.enum(WORKFLOW_ACTIONS).describe(
    "list: saved workflows. get: one definition (name). save: validate and write (workflow, scope). delete (name, scope). " +
      "run: start a saved workflow (name) or an unsaved one (workflow) with inputs; returns the run id at once. " +
      "status: all runs, or one run by id with each step's status, cost, model, log, and report. " +
      "stop, resume, skip_wait, background, foreground: control a run (id). message: steer the agent that works now (id, message).",
  ),
  name: z.string().optional().describe("Workflow name for get, save, delete, run"),
  workflow: z.record(z.string(), z.unknown()).optional().describe("A full workflow definition, in the format of the workflow-create skill"),
  scope: z.enum(["global", "project"]).optional().describe("Where save writes or delete removes. Default: where the workflow is now, else global"),
  inputs: z.record(z.string(), z.string()).optional().describe("Values for the {{placeholders}} of the prompts; goal for dynamic workflows"),
  models: z
    .record(z.string(), z.string())
    .optional()
    .describe('Models for steps marked "ask": key -1 for the workflow default, else the step index'),
  background: z.boolean().optional().describe("For run: keep the run going when Paseo's plugin stops. Default true"),
  worktree: z
    .union([z.boolean(), z.string()])
    .optional()
    .describe("For run: true runs in a new Paseo worktree of this project instead of the agent's directory; a string also names its branch"),
  id: z.string().optional().describe("Run id for status and run control"),
  message: z.string().optional().describe("For message: text the working step agent reads as steering"),
});

function text(value: string, isError = false) {
  return { text: value, isError };
}

function runLine(run: { id: string; workflow: string; status: Parameters<typeof statusLabel>[0]; stale: boolean; stepsDone: number; stepCount: number; cost: number; currentStepName: string | null; approval: { task: string } | null; cwd: string }) {
  const cost = run.cost > 0 ? ` · $${run.cost.toFixed(2)}` : "";
  const now = isActive(run.status) && run.currentStepName ? ` · at ${run.currentStepName}` : "";
  const approval = run.approval ? ` · waits for approval of "${run.approval.task}"` : "";
  return `${run.id} ${run.workflow}: ${statusLabel(run.status, run.stale)} (${run.stepsDone}/${run.stepCount} steps${cost})${now}${approval} · ${run.cwd}`;
}

export const workflowsTool = defineAgentTool({
  name: "pi_workflows",
  title: "Pi Rust workflows",
  description:
    "Create, edit, run, and watch Pi Rust workflows: multi-agent pipelines where each step is a pi agent with its own model, " +
    "tools, skills, and MCP servers, and tasks can wait, repeat, loop until a goal, or wait for the user's approval. " +
    "Runs go on in the background; this tool cannot answer approvals, the user answers them in Paseo or pi. " +
    "Load the workflow-create skill or call get on an existing workflow before writing a definition.",
  input: workflowInput,
  async execute(input, { agent, paseo }) {
    const cwd = agent.cwd;
    switch (input.action) {
      case "list": {
        const { found, errors } = await loadWorkflows(cwd);
        const lines = found.map(({ workflow, source }) => {
          const inputs = workflowInputs(workflow);
          return `${workflow.name} (${source}, ${workflow.mode ?? "fixed"}, ${workflow.steps.length} steps${inputs.length ? `, inputs: ${inputs.join(", ")}` : ""}): ${workflow.description ?? ""}`;
        });
        for (const error of errors) lines.push(`unreadable: ${error}`);
        return text(lines.length ? lines.join("\n") : "No workflows yet. Use save to create one.");
      }
      case "get": {
        if (!input.name) return text("get needs a name.", true);
        const { workflow, source, path } = await getWorkflow({ name: input.name, cwd });
        return { text: `${source} workflow at ${path}:\n${JSON.stringify(workflow, null, 2)}`, structuredContent: workflow };
      }
      case "save": {
        if (!input.workflow) return text("save needs a workflow definition.", true);
        const parsed = parseWorkflow(input.workflow);
        if (!parsed.ok) return text(parsed.error, true);
        const name = slug(input.name ?? parsed.workflow.name);
        let scope = input.scope;
        let previous: { name: string; scope: "global" | "project" } | undefined;
        try {
          const existing = await findWorkflow(name, cwd);
          scope ??= existing.source;
          if (existing.source === scope) previous = { name, scope };
        } catch {
          scope ??= "global";
        }
        const saved = await saveWorkflow({ ...parsed.workflow, name }, scope, cwd, { previous });
        return text(`Saved ${saved.source} workflow ${saved.name} to ${saved.path}.`);
      }
      case "delete": {
        if (!input.name) return text("delete needs a name.", true);
        const existing = await findWorkflow(input.name, cwd, input.scope);
        const { path } = await deleteWorkflow({ name: existing.workflow.name, scope: existing.source, cwd });
        return text(`Deleted ${path}.`);
      }
      case "run": {
        let workflow;
        if (input.workflow) {
          const parsed = parseWorkflow(input.workflow);
          if (!parsed.ok) return text(parsed.error, true);
          workflow = parsed.workflow;
        } else if (input.name) {
          workflow = (await findWorkflow(input.name, cwd)).workflow;
        } else {
          return text("run needs a name or a workflow.", true);
        }
        const models: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(input.models ?? {})) models[key] = value;
        workflow = resolveAskModels(normalizeWorkflow(workflow), models);
        let runCwd = cwd;
        let where = cwd;
        if (input.worktree) {
          const created = await createRunWorktree(paseo, cwd, typeof input.worktree === "string" ? input.worktree : undefined, `${workflow.name} run`);
          runCwd = created.directory;
          where = `a new worktree, ${created.directory}`;
        }
        const id = await startRun({
          workflow,
          cwd: runCwd,
          inputs: input.inputs ?? {},
          background: input.background ?? true,
          origin: "agent",
          agentId: agent.id,
        });
        await appendRunCard(paseo, agent.id, id, workflow.name);
        const report = currentSettings().reportToAgent ? " You get its report when it ends." : "";
        return text(`Started run ${id} of ${workflow.name} in ${where}.${report} Use status with the id to check it.`);
      }
      case "status": {
        if (!input.id) {
          const { runs } = await listRuns({ limit: 30 });
          return text(runs.length ? runs.map(runLine).join("\n") : "No runs.");
        }
        const { run } = await getRun({ id: input.id });
        const lines = [runLine(run)];
        if (run.note) lines.push(`Note: ${run.note}`);
        if (run.error) lines.push(`Error: ${run.error}`);
        run.steps.forEach((step, index) => {
          const time = step.startedMs ? formatDuration(((step.endedMs ?? Date.now()) - step.startedMs) / 1000) : "-";
          lines.push(
            `${index + 1}. ${step.name}: ${step.status} · ${time} · $${step.cost.toFixed(2)} · ${step.runs} runs · ${step.turns} turns${step.model ? ` · ${step.model}` : ""} · tasks ${step.tasksDone}/${step.taskCount}`,
          );
          for (const entry of step.log) lines.push(`   log: ${entry}`);
          if (step.activity) lines.push(`   now: ${step.activity}`);
          if (step.summary) lines.push(`   report: ${step.summary}`);
        });
        return { text: lines.join("\n"), structuredContent: run };
      }
      case "stop":
      case "resume":
      case "background":
      case "foreground":
      case "skip_wait": {
        if (!input.id) return text(`${input.action} needs a run id.`, true);
        const action = input.action === "skip_wait" ? "skip" : input.action;
        return text(await controlRun(input.id, action));
      }
      case "message": {
        if (!input.id || !input.message) return text("message needs a run id and a message.", true);
        return text(await steerRun(input.id, input.message));
      }
    }
  },
});

export const extensionsTool = defineAgentTool({
  name: "pi_extensions",
  title: "Pi Rust extensions",
  description:
    "Manage Pi Rust extensions: list installed extensions and packages, search the marketplace, show details, install, " +
    "remove, enable, disable, or update one, and run an extension's slash command (such as deferred status) without a model turn. " +
    "Changes apply to new pi sessions; running ones need /reload.",
  input: z.object({
    action: z.enum(["list", "search", "info", "command", ...EXTENSION_ACTIONS]),
    target: z
      .string()
      .optional()
      .describe("For install and remove: marketplace:<name>, npm:<package>, git:<url>, or a path. For enable and disable: the reference from list. For info: the marketplace name. For update: the package source"),
    query: z.string().optional().describe("For search"),
    command: z.string().optional().describe("For command: the slash command name without the slash, such as deferred"),
    args: z.string().optional().describe("For command: its arguments, such as status"),
    scope: z.enum(["global", "project"]).optional().describe("global (default) or project, the agent's working directory"),
  }),
  async execute(input, { agent }) {
    const scope = input.scope ?? "global";
    const cwd = agent.cwd;
    switch (input.action) {
      case "list": {
        const { extensions, packages } = await listExtensions({ scope, cwd });
        const lines = ["Extensions:"];
        for (const ext of extensions) lines.push(`${ext.enabled ? "[x]" : "[ ]"} ${ext.reference} (${ext.source})`);
        lines.push("Packages:");
        for (const pkg of packages) lines.push(`${pkg.scope}: ${pkg.source}${pkg.filtered ? " (filtered)" : ""}`);
        return text(lines.join("\n"));
      }
      case "search": {
        const { results, error } = await searchExtensions({ query: input.query ?? "" });
        if (error) return text(error, true);
        return text(
          results.length
            ? results.map((r) => `${r.name} (${r.version})${r.installed ? ` [installed: ${r.installed}]` : ""}: ${r.description}`).join("\n")
            : "No marketplace extensions found.",
        );
      }
      case "command": {
        if (!input.command) return text("command needs a command name.", true);
        const result = await runExtensionCommand({ cwd, command: input.command.replace(/^\//, ""), args: input.args ?? "" });
        const lines = result.output.map((notice) => (notice.level === "info" ? notice.text : `[${notice.level}] ${notice.text}`));
        if (result.neededUi) lines.push("(The command asked a question that needs pi's UI; it was cancelled.)");
        if (result.agentInvoked) lines.push("(The command started an agent turn, which was stopped.)");
        return text(lines.join("\n\n") || `/${input.command} ran and printed nothing.`);
      }
      case "info": {
        if (!input.target) return text("info needs a target.", true);
        return text((await extensionInfo({ name: input.target })).text);
      }
      default: {
        if (!input.target) return text(`${input.action} needs a target.`, true);
        const result = await extensionCommand(input.action, input.target, scope, cwd);
        return text(result.output || (result.ok ? "Done." : `pi exited with ${result.code}`), !result.ok);
      }
    }
  },
});

export const agentTools: AgentToolDefinition[] = [workflowsTool, extensionsTool];
