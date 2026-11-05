// Workflow definitions on disk, the catalog that steps name skills and MCP servers from, and
// model-written drafts (extensions/workflows/src/{store,app,planner}.rs).
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  catalogRpc,
  ScopeName,
  workflowDeleteRpc,
  workflowDraftRpc,
  workflowGetRpc,
  WorkflowListItem,
  workflowSaveRpc,
  workflowsListRpc,
} from "../shared/contracts";
import {
  askModels,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  normalizeWorkflow,
  parseWorkflow,
  parseWorkflowText,
  slug,
  stepScope,
  workflowInputs,
  workflowProblems,
  type Workflow,
} from "../shared/workflow";
import { listDir, prettyJson, readJson, readText, writeAtomic } from "./fsutil";
import { agentDir, piEnv, projectDir, requirePi, runPi } from "./pi";
import { projectTrusted } from "./trust";

export function workflowsRoot(): string {
  return path.join(agentDir(), "ext", "workflows");
}

export function definitionsDir(scope: ScopeName, cwd?: string): string {
  if (scope === "global") return path.join(workflowsRoot(), "definitions");
  if (!cwd) throw new Error("Project workflows need a working directory.");
  return path.join(projectDir(cwd), "ext", "workflows", "definitions");
}

export interface StoredWorkflow {
  workflow: Workflow;
  source: ScopeName;
  path: string;
}

/** A definition file; its file name is the workflow name. */
async function readDefinition(file: string): Promise<Workflow> {
  const text = await readText(file);
  if (text === null) throw new Error(`${file}: not found`);
  const parsed = parseWorkflowText(text);
  if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
  return { ...parsed.workflow, name: slug(path.basename(file, ".json")) };
}

/** All workflows by name; a project workflow hides a global one of the same name. */
export async function loadWorkflows(cwd?: string): Promise<{ found: StoredWorkflow[]; errors: string[] }> {
  const found: StoredWorkflow[] = [];
  const errors: string[] = [];
  const scopes: ScopeName[] = cwd ? ["project", "global"] : ["global"];
  for (const scope of scopes) {
    const dir = definitionsDir(scope, cwd);
    const files = (await listDir(dir)).filter((name) => name.endsWith(".json")).sort();
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const workflow = await readDefinition(full);
        if (found.some((stored) => stored.workflow.name === workflow.name)) continue;
        found.push({ workflow, source: scope, path: full });
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  }
  found.sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));
  return { found, errors };
}

export async function findWorkflow(name: string, cwd?: string, source?: ScopeName): Promise<StoredWorkflow> {
  const wanted = slug(name);
  const { found } = await loadWorkflows(cwd);
  const match = found.find((stored) => stored.workflow.name === wanted && (!source || stored.source === source));
  if (match) return match;
  if (source) {
    const file = path.join(definitionsDir(source, cwd), `${wanted}.json`);
    return { workflow: await readDefinition(file), source, path: file };
  }
  throw new Error(`No workflow ${wanted}.`);
}

function listItem(stored: StoredWorkflow): WorkflowListItem {
  const { workflow } = stored;
  return {
    name: workflow.name,
    description: workflow.description ?? "",
    mode: workflow.mode ?? "fixed",
    context: workflow.context ?? "handoff",
    background: workflow.background ?? false,
    source: stored.source,
    path: stored.path,
    stepCount: workflow.steps.length,
    taskCount: workflow.steps.reduce((sum, step) => sum + step.tasks.length, 0),
    inputs: workflowInputs(workflow),
    askModels: askModels(workflow),
    problems: workflowProblems(workflow),
    steps: workflow.steps.map((step) => {
      const scope = stepScope(workflow, step);
      return {
        name: step.name,
        model: scope.model ?? null,
        thinking: scope.thinking ?? null,
        tasks: step.tasks.length,
        approval: step.tasks.some((task) => task.confirm),
        loop: step.tasks.some((task) => Boolean(task.until) || (task.repeat ?? 1) > 1),
        wait: step.tasks.some((task) => Boolean(task.delay) || Boolean(task.every)),
      };
    }),
  };
}

export async function listWorkflows({ cwd }: RpcInput<typeof workflowsListRpc>): Promise<RpcOutput<typeof workflowsListRpc>> {
  const { found, errors } = await loadWorkflows(cwd);
  return {
    workflows: found.map(listItem),
    errors,
    globalDir: definitionsDir("global"),
    projectDir: cwd ? definitionsDir("project", cwd) : null,
    trusted: cwd ? projectTrusted(cwd) : true,
  };
}

export async function getWorkflow({ name, cwd, source }: RpcInput<typeof workflowGetRpc>): Promise<RpcOutput<typeof workflowGetRpc>> {
  const stored = await findWorkflow(name, cwd, source);
  return { workflow: normalizeWorkflow(stored.workflow) as Record<string, unknown>, source: stored.source, path: stored.path };
}

/** Validates the workflow and writes `<slug>.json` to the scope's directory. */
export async function saveWorkflow(
  value: unknown,
  scope: ScopeName,
  cwd: string | undefined,
  options: { previous?: { name: string; scope: ScopeName }; overwrite?: boolean } = {},
): Promise<{ name: string; path: string; source: ScopeName }> {
  const parsed = parseWorkflow(value);
  if (!parsed.ok) throw new Error(parsed.error);
  const problems = workflowProblems(parsed.workflow);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (scope === "project" && cwd && !projectTrusted(cwd)) {
    throw new Error("The project is not trusted, so workflows cannot be saved there. Trust it in pi first.");
  }
  const workflow = normalizeWorkflow({ ...parsed.workflow, name: slug(parsed.workflow.name) });
  const file = path.join(definitionsDir(scope, cwd), `${workflow.name}.json`);
  const previous = options.previous;
  const renamed = !previous || slug(previous.name) !== workflow.name || previous.scope !== scope;
  if (renamed && !options.overwrite && (await readText(file)) !== null) {
    throw new Error(`A ${scope} workflow named ${workflow.name} exists already.`);
  }
  await writeAtomic(file, prettyJson(workflow));
  if (previous && renamed) {
    const old = path.join(definitionsDir(previous.scope, cwd), `${slug(previous.name)}.json`);
    if (old !== file) await fs.rm(old, { force: true });
  }
  return { name: workflow.name, path: file, source: scope };
}

export function saveWorkflowRpc({ workflow, scope, cwd, previous, overwrite }: RpcInput<typeof workflowSaveRpc>): Promise<RpcOutput<typeof workflowSaveRpc>> {
  return saveWorkflow(workflow, scope, cwd, { previous, overwrite });
}

export async function deleteWorkflow({ name, scope, cwd }: RpcInput<typeof workflowDeleteRpc>): Promise<RpcOutput<typeof workflowDeleteRpc>> {
  const file = path.join(definitionsDir(scope, cwd), `${slug(name)}.json`);
  if ((await readText(file)) === null) throw new Error(`No ${scope} workflow ${slug(name)}.`);
  await fs.rm(file);
  return { path: file };
}

// Catalog -----------------------------------------------------------------------------------

export interface Catalog {
  /** Skill name to `SKILL.md` path. */
  skills: Record<string, string>;
  mcpServers: string[];
  models: string[];
  parentModel: string | null;
  parentThinking: string | null;
}

interface ProbeResult {
  commands: { name?: string; sourceInfo?: { path?: string } }[];
  models: { provider?: string; id?: string }[];
  state: { model?: { provider?: string; id?: string } | null; thinkingLevel?: string | null } | null;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const PROBE_TIMEOUT_MS = 45_000;

/**
 * Starts pi in RPC mode in `cwd` and asks it for its commands (skills with their paths), its
 * models, and its state. `PI_WORKFLOW_RUN` keeps the workflows extension in its step-agent mode,
 * so the probe neither watches nor reports runs.
 */
function probe(cwd: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "rpc", "--no-session", projectTrusted(cwd) ? "--approve" : "--no-approve"];
    const child = spawn(requirePi(), args, {
      cwd,
      env: piEnv({ PI_WORKFLOW_RUN: "paseo-catalog", PI_OFFLINE: "1" }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const result: ProbeResult = { commands: [], models: [], state: null };
    const pending = new Set(["commands", "models", "state"]);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("pi did not answer the catalog request in time")), PROBE_TIMEOUT_MS);
    const send = (record: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(record)}\n`);
    };
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (pending.size > 0) finish(new Error(`pi exited (${code}) before it answered the catalog request`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type === "extension_ui_request" && DIALOG_METHODS.has(String(message.method))) {
          send({ type: "extension_ui_response", id: message.id, cancelled: true });
          continue;
        }
        if (message.type !== "response" || typeof message.id !== "string" || !pending.has(message.id)) continue;
        const data = (message.data ?? null) as Record<string, unknown> | null;
        if (message.id === "commands") result.commands = (data?.commands as ProbeResult["commands"]) ?? [];
        if (message.id === "models") result.models = (data?.models as ProbeResult["models"]) ?? [];
        if (message.id === "state") result.state = data as ProbeResult["state"];
        pending.delete(message.id);
        if (pending.size === 0) finish();
      }
    });
    send({ id: "commands", type: "get_commands" });
    send({ id: "models", type: "get_available_models" });
    send({ id: "state", type: "get_state" });
  });
}

async function mcpServers(cwd: string): Promise<string[]> {
  const files = [path.join(agentDir(), "mcp.json")];
  if (projectTrusted(cwd)) files.push(path.join(projectDir(cwd), "mcp.json"));
  const names: string[] = [];
  for (const file of files) {
    try {
      const config = await readJson<{ mcpServers?: Record<string, unknown> }>(file);
      for (const name of Object.keys(config?.mcpServers ?? {})) if (!names.includes(name)) names.push(name);
    } catch {
      // A broken mcp.json lists no servers; pi reports it in doctor.
    }
  }
  return names;
}

const catalogCache = new Map<string, { at: number; catalog: Catalog }>();
const CATALOG_TTL_MS = 2 * 60_000;

export async function loadCatalog(cwd: string, refresh = false): Promise<Catalog> {
  const cached = catalogCache.get(cwd);
  if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
  const result = await probe(cwd);
  const skills: Record<string, string> = {};
  for (const command of result.commands) {
    const name = command.name?.startsWith("skill:") ? command.name.slice("skill:".length) : null;
    const file = command.sourceInfo?.path;
    if (name && file) skills[name] = file;
  }
  // The workflows extension adds its own skills through `resources_discover`, which the probe skips.
  for (const name of ["workflow-create", "workflow-optimize"]) {
    const file = path.join(workflowsRoot(), "skills", name, "SKILL.md");
    if (!skills[name] && (await readText(file)) !== null) skills[name] = file;
  }
  const model = result.state?.model;
  const catalog: Catalog = {
    skills,
    mcpServers: await mcpServers(cwd),
    models: result.models
      .filter((m) => m.provider && m.id)
      .map((m) => `${m.provider}/${m.id}`),
    parentModel: model?.provider && model.id ? `${model.provider}/${model.id}` : null,
    parentThinking: result.state?.thinkingLevel ?? null,
  };
  catalogCache.set(cwd, { at: Date.now(), catalog });
  return catalog;
}

const BUILTIN_SUBAGENTS = ["explore", "build", "advisor"];
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Built-in subagent types and the custom agent files of the subagents extension. */
export async function subagentTypes(cwd?: string): Promise<string[]> {
  const names = [...BUILTIN_SUBAGENTS];
  const dirs = [path.join(agentDir(), "ext", "subagents", "agents")];
  if (cwd && projectTrusted(cwd)) dirs.push(path.join(projectDir(cwd), "ext", "subagents", "agents"));
  for (const dir of dirs) {
    for (const file of await listDir(dir)) {
      const name = file.endsWith(".md") ? file.slice(0, -3) : null;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export async function catalog({ cwd, refresh }: RpcInput<typeof catalogRpc>): Promise<RpcOutput<typeof catalogRpc>> {
  const dir = cwd ?? process.cwd();
  const subagents = await subagentTypes(cwd);
  try {
    const loaded = await loadCatalog(dir, refresh);
    return {
      skills: Object.keys(loaded.skills).sort(),
      mcpServers: loaded.mcpServers,
      subagents,
      models: loaded.models,
      tools: BUILTIN_TOOLS,
      error: null,
    };
  } catch (error) {
    return {
      skills: [],
      mcpServers: await mcpServers(dir),
      subagents,
      models: [],
      tools: BUILTIN_TOOLS,
      error: (error as Error).message,
    };
  }
}

/** What a dynamic workflow's planner may use. */
export async function plannerAvailable(cwd: string, loaded: Catalog): Promise<Record<string, unknown>> {
  return {
    models: loaded.models.slice(0, 80),
    skills: Object.keys(loaded.skills),
    tools: BUILTIN_TOOLS,
    mcpServers: loaded.mcpServers,
    subagents: await subagentTypes(cwd),
  };
}

// Drafts ------------------------------------------------------------------------------------

const GENERATE_RULES =
  "You design pi workflows. Turn the user's description into one workflow. Use the real commands and names " +
  "from the description. Use {{name}} placeholders for facts that change per run. Pick strong models for " +
  "implementation, small models for polling and monitoring, `until` for waits on CI or deploys, and " +
  "`confirm: true` before merges to main, production deploys, and destructive commands. Answer with the " +
  "workflow JSON object and nothing else.";

/** The file format reference that the workflows extension installs with its skills. */
async function formatReference(): Promise<string> {
  const text = await readText(path.join(workflowsRoot(), "skills", "workflow-create", "SKILL.md"));
  if (!text) return "";
  return text.replace(/^---[\s\S]*?---\s*/, "");
}

/** The JSON object in a model answer, with or without a code fence. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the model answered without JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`the model's JSON is not a valid workflow: ${(error as Error).message}`);
  }
}

export async function draftWorkflow({ description, cwd, model }: RpcInput<typeof workflowDraftRpc>): Promise<RpcOutput<typeof workflowDraftRpc>> {
  const dir = cwd ?? process.cwd();
  let available: Record<string, unknown> = {};
  try {
    available = await plannerAvailable(dir, await loadCatalog(dir));
  } catch {
    // Without the catalog the model drafts from the description alone.
  }
  const system = `${GENERATE_RULES}\n\n${await formatReference()}`;
  const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--system-prompt", system];
  args.push("--model", model ?? DEFAULT_MODEL);
  if (!model) args.push("--thinking", DEFAULT_THINKING);
  args.push("--", JSON.stringify({ description, available }, null, 2));
  const result = await runPi(args, { cwd: dir, timeoutMs: 300_000, env: { PI_WORKFLOW_RUN: "paseo-draft" } });
  if (result.code !== 0) {
    throw new Error(`The workflow draft failed: ${(result.stderr.trim() || result.stdout.trim()).split("\n").slice(-4).join("\n")}`);
  }
  const parsed = parseWorkflow(extractJson(result.stdout));
  if (!parsed.ok) throw new Error(`the model's JSON is not a valid workflow: ${parsed.error}`);
  const workflow = normalizeWorkflow({ ...parsed.workflow, name: slug(parsed.workflow.name) });
  return { workflow: workflow as Record<string, unknown>, problems: workflowProblems(workflow) };
}
