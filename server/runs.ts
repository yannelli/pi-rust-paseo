// Workflow runs through the runner's file protocol (extensions/workflows/src/{runs,control,app}.rs):
// the runner owns `run.json`; the plugin reads it, queues commands in `commands/`, and passes
// messages to the working agent through `inbox/`. Starting or resuming a run spawns
// `pi-rust-ext workflows --runner <dir>` detached, as pi does, so runs outlive the plugin.
import { spawn } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import path from "node:path";
import type { PaseoApi } from "./paseo";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  RUN_CARD_KIND,
  RUN_CARD_VERSION,
  type RunAction,
  type runFilesRpc,
  type runGetRpc,
  type runOutputRpc,
  type runsListRpc,
  type runStartRpc,
} from "../shared/contracts";
import {
  isActive,
  STALE_MS,
  type Decision,
  type OutputEntry,
  type RunDetail,
  type RunStatus,
  type RunSummary,
  type StepRun,
  type StepStatus,
} from "../shared/runs";
import {
  formatDuration,
  normalizeWorkflow,
  parseWorkflow,
  resolveAskModels,
  stepScope,
  workflowInputs,
  workflowProblems,
  type Workflow,
} from "../shared/workflow";
import { exists, listDir, prettyJson, readJson, readTail, readText, writeAtomic } from "./fsutil";
import { agentDir, currentSettings, expandHome, piBinary, piEnv, requirePi, which } from "./pi";
import { findWorkflow, loadCatalog, plannerAvailable, workflowsRoot } from "./workflows";

const REPORT_SCHEMA = `{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["done", "continue", "blocked"] },
    "summary": { "type": "string" }
  },
  "required": ["status", "summary"],
  "additionalProperties": false
}
`;

const PLAN_SCHEMA = `{
  "type": "object",
  "properties": { "steps": { "type": "array", "items": { "type": "object" } } },
  "required": ["steps"]
}
`;

/** The side file that links a run to the Paseo agent that started it. The runner ignores it. */
const PASEO_FILE = "paseo.json";
/** A pi refreshes its liveness file this often; the runner treats a file older than 10 s as gone. */
const TOUCH_EVERY_MS = 2_000;
const OUTPUT_ENTRIES = 400;

interface PaseoLink {
  agentId: string | null;
  origin: "user" | "agent";
}

/** `run.json` as the runner writes it; fields are read defensively. */
interface RawStep {
  status?: StepStatus;
  tasksDone?: number;
  runs?: number;
  startedMs?: number | null;
  endedMs?: number | null;
  summary?: string;
  cost?: number;
  turns?: number;
  model?: string | null;
  log?: string[];
  activity?: string;
  writing?: string;
}

interface RawRun {
  id: string;
  workflow: Workflow;
  inputs?: Record<string, string>;
  cwd?: string;
  origin?: string;
  status?: RunStatus;
  startedMs?: number;
  endedMs?: number | null;
  steps?: RawStep[];
  waitUntilMs?: number | null;
  note?: string;
  error?: string | null;
  parentModel?: string | null;
  parentThinking?: string | null;
  background?: boolean;
  owner?: number;
  heartbeatMs?: number;
  approval?: { task: string; step: number; askedMs: number } | null;
  pi?: string;
  catalog?: { skills?: Record<string, string>; mcpServers?: string[] };
  available?: unknown;
}

export function runsDir(): string {
  return path.join(workflowsRoot(), "runs");
}

function runDir(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid run id ${id}.`);
  return path.join(runsDir(), id);
}

async function readRun(id: string): Promise<{ raw: RawRun; dir: string; link: PaseoLink | null }> {
  const dir = runDir(id);
  let raw: RawRun | null;
  try {
    raw = await readJson<RawRun>(path.join(dir, "run.json"));
  } catch (error) {
    throw new Error(`Run ${id} has an unreadable run.json: ${(error as Error).message}`);
  }
  if (!raw) throw new Error(`No run ${id}.`);
  const link = await readJson<PaseoLink>(path.join(dir, PASEO_FILE)).catch(() => null);
  return { raw, dir, link };
}

function stale(raw: RawRun): boolean {
  return isActive(raw.status ?? "running") && Date.now() - (raw.heartbeatMs ?? 0) > STALE_MS;
}

function stepsOf(raw: RawRun): StepRun[] {
  const definition = raw.workflow?.steps ?? [];
  const steps = raw.steps ?? [];
  return definition.map((step, index) => {
    const state = steps[index] ?? {};
    return {
      name: step.name,
      status: state.status ?? "pending",
      tasksDone: state.tasksDone ?? 0,
      taskCount: step.tasks?.length ?? 0,
      runs: state.runs ?? 0,
      startedMs: state.startedMs ?? null,
      endedMs: state.endedMs ?? null,
      summary: state.summary ?? "",
      cost: state.cost ?? 0,
      turns: state.turns ?? 0,
      model: state.model ?? null,
      log: state.log ?? [],
      activity: state.activity ?? "",
      writing: state.writing ?? "",
    };
  });
}

function summarize(raw: RawRun, link: PaseoLink | null): RunSummary {
  const steps = stepsOf(raw);
  const running = steps.findIndex((step) => step.status === "running");
  const unfinished = steps.findIndex((step) => step.status !== "done");
  const current = running >= 0 ? running : unfinished >= 0 ? unfinished : null;
  const agent = steps.findIndex((step) => step.activity.length > 0);
  return {
    id: raw.id,
    workflow: raw.workflow?.name ?? "",
    description: raw.workflow?.description ?? "",
    mode: raw.workflow?.mode ?? "fixed",
    status: raw.status ?? "running",
    stale: stale(raw),
    cwd: raw.cwd ?? "",
    origin: raw.origin ?? "user",
    startedMs: raw.startedMs ?? 0,
    endedMs: raw.endedMs ?? null,
    waitUntilMs: raw.waitUntilMs ?? null,
    note: raw.note ?? "",
    error: raw.error ?? null,
    background: raw.background ?? false,
    owner: raw.owner ?? 0,
    ownedHere: raw.owner === process.pid,
    approval: raw.approval ?? null,
    cost: steps.reduce((sum, step) => sum + step.cost, 0),
    stepCount: steps.length,
    stepsDone: steps.filter((step) => step.status === "done").length,
    currentStep: current,
    agentStep: agent >= 0 ? agent : null,
    currentStepName: current !== null ? steps[current].name : null,
    activity: agent >= 0 ? steps[agent].activity : "",
    inputs: raw.inputs ?? {},
    paseoAgentId: link?.agentId ?? null,
  };
}

export async function listRuns({ cwd, workflow, limit }: RpcInput<typeof runsListRpc>): Promise<RpcOutput<typeof runsListRpc>> {
  const ids = (await listDir(runsDir())).filter((name) => name.startsWith("wf-"));
  const runs: RunSummary[] = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { raw, link } = await readRun(id);
        if (cwd && path.resolve(raw.cwd ?? "") !== path.resolve(cwd)) return;
        if (workflow && raw.workflow?.name !== workflow) return;
        runs.push(summarize(raw, link));
      } catch {
        // A run directory without a readable run.json is skipped, as pi skips it.
      }
    }),
  );
  runs.sort((a, b) => b.startedMs - a.startedMs);
  return { runs: runs.slice(0, limit ?? 100) };
}

export async function getRun({ id }: RpcInput<typeof runGetRpc>): Promise<RpcOutput<typeof runGetRpc>> {
  const { raw, dir, link } = await readRun(id);
  const detail: RunDetail = {
    ...summarize(raw, link),
    steps: stepsOf(raw),
    definition: (raw.workflow ?? {}) as Record<string, unknown>,
    parentModel: raw.parentModel ?? null,
    parentThinking: raw.parentThinking ?? null,
    pi: raw.pi ?? "",
    dir,
  };
  return { run: detail };
}

export async function runOutput({ id, step, limit }: RpcInput<typeof runOutputRpc>): Promise<RpcOutput<typeof runOutputRpc>> {
  const file = path.join(runDir(id), "output", `${String(step + 1).padStart(2, "0")}.jsonl`);
  const text = await readTail(file, 2 * 1024 * 1024);
  const entries: OutputEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { kind?: unknown; text?: unknown };
      if (typeof entry.kind === "string" && typeof entry.text === "string") entries.push({ kind: entry.kind, text: entry.text });
    } catch {
      // The runner may be writing the last line.
    }
  }
  const max = Math.min(limit ?? OUTPUT_ENTRIES, OUTPUT_ENTRIES);
  return { entries: entries.slice(-max), total: entries.length };
}

export async function runFiles({ id }: RpcInput<typeof runFilesRpc>): Promise<RpcOutput<typeof runFilesRpc>> {
  const dir = runDir(id);
  return {
    memory: (await readText(path.join(dir, "memory.md"))) ?? "",
    runnerLog: await readTail(path.join(dir, "runner.log"), 64 * 1024),
  };
}

// Commands ----------------------------------------------------------------------------------

type Command =
  | { type: "stop" }
  | { type: "interrupt" }
  | { type: "skip" }
  | { type: "approve"; decision: Decision }
  | { type: "mode"; background: boolean; owner: number };

let queued = 0;

async function queue(dir: string, text: string): Promise<void> {
  const name = `${String(Date.now()).padStart(13, "0")}-${process.pid}-${queued++}.json`;
  await writeAtomic(path.join(dir, name), text);
}

async function sendCommand(id: string, command: Command): Promise<void> {
  await queue(path.join(runDir(id), "commands"), JSON.stringify(command));
}

async function activeRun(id: string): Promise<{ raw: RawRun; dir: string; link: PaseoLink | null }> {
  const run = await readRun(id);
  if (!isActive(run.raw.status ?? "running")) throw new Error(`Run ${id} is not active.`);
  return run;
}

export async function stopRun(id: string): Promise<string> {
  const { raw } = await activeRun(id);
  await sendCommand(id, { type: "stop" });
  return `Stopping ${raw.workflow.name} (${id}).`;
}

export async function skipWait(id: string): Promise<string> {
  const { raw } = await activeRun(id);
  if (raw.waitUntilMs == null) throw new Error(`Run ${id} is not waiting.`);
  await sendCommand(id, { type: "skip" });
  return `Ended the wait of ${raw.workflow.name}.`;
}

export async function approveRun(id: string, decision: Decision): Promise<string> {
  const { raw } = await activeRun(id);
  if (!raw.approval) throw new Error(`Run ${id} does not wait for an approval.`);
  await sendCommand(id, { type: "approve", decision });
  const word = { run: "Approved", skip: "Skipped", stop: "Stopping the run at" }[decision];
  return `${word} "${raw.approval.task}" of ${raw.workflow.name}.`;
}

/** A background run keeps going when its owner stops; a foreground run follows this plugin. */
export async function setBackground(id: string, background: boolean): Promise<string> {
  const { raw } = await activeRun(id);
  touchLiveness();
  await sendCommand(id, { type: "mode", background, owner: process.pid });
  return background
    ? `${raw.workflow.name} runs in the background.`
    : `${raw.workflow.name} runs in the foreground of Paseo; it stops as interrupted when the plugin stops.`;
}

/** Passes `message` to the agent that runs now; it reads it after its current tool call. */
export async function steerRun(id: string, message: string): Promise<string> {
  const { raw } = await activeRun(id);
  if (!(raw.steps ?? []).some((step) => (step.activity ?? "").length > 0)) {
    throw new Error(`No agent of run ${id} works now.`);
  }
  await queue(path.join(runDir(id), "inbox"), JSON.stringify(message.trim()));
  return "Sent. The agent reads it after its current tool call.";
}

export async function deleteRun(id: string): Promise<string> {
  const { raw, dir } = await readRun(id);
  if (isActive(raw.status ?? "running") && !stale(raw)) throw new Error(`Run ${id} is still active. Stop it first.`);
  await fs.rm(dir, { recursive: true, force: true });
  return `Deleted run ${id}.`;
}

export async function controlRun(id: string, action: RunAction, decision?: Decision): Promise<string> {
  switch (action) {
    case "stop":
      return stopRun(id);
    case "skip":
      return skipWait(id);
    case "approve":
      return approveRun(id, decision ?? "run");
    case "background":
      return setBackground(id, true);
    case "foreground":
      return setBackground(id, false);
    case "resume":
      await resumeRun(id);
      return `Resumed run ${id}.`;
    case "delete":
      return deleteRun(id);
  }
}

// Liveness ----------------------------------------------------------------------------------

function livenessFile(): string {
  return path.join(workflowsRoot(), "sessions", String(process.pid));
}

/** Keeps `sessions/<pid>` fresh, so runs this plugin owns see their owner alive. */
export function touchLiveness(): void {
  void writeAtomic(livenessFile(), String(Date.now())).catch(() => {});
}

async function ownerAlive(owner: number): Promise<boolean> {
  const text = await readText(path.join(workflowsRoot(), "sessions", String(owner))).catch(() => null);
  if (text === null) return false;
  const at = Number(text.trim());
  return !Number.isFinite(at) || Date.now() - at < 10_000;
}

// Starting and resuming ---------------------------------------------------------------------

interface RunnerCommand {
  command: string;
  args: string[];
}

interface NativeEntry {
  command?: string;
  args?: string[];
}

interface PackageJson {
  name?: string;
  pi?: { native?: NativeEntry[] };
  piMarketplace?: { name?: string; version?: string };
  version?: string;
}

async function workflowsPackage(): Promise<{ manifest: PackageJson; file: string } | null> {
  const dirs = [
    path.join(agentDir(), "marketplace", "packages"),
    path.join(agentDir(), "npm", "node_modules", "@pi-rust-extensions"),
  ];
  for (const dir of dirs) {
    for (const name of await listDir(dir)) {
      const file = path.join(dir, name, "package.json");
      const manifest = await readJson<PackageJson>(file).catch(() => null);
      if (!manifest) continue;
      if (manifest.name === "@pi-rust-extensions/workflows" || manifest.piMarketplace?.name === "workflows") {
        return { manifest, file };
      }
    }
  }
  return null;
}

/** The installed workflows extension: its version and the runner command. */
export async function workflowsExtension(): Promise<{ installed: boolean; version: string | null; runner: RunnerCommand | null; error: string | null }> {
  const configured = currentSettings().runnerPath.trim();
  const found = await workflowsPackage();
  const version = found?.manifest.piMarketplace?.version ?? found?.manifest.version ?? null;
  if (configured) {
    return { installed: true, version, runner: { command: path.resolve(expandHome(configured)), args: ["workflows"] }, error: null };
  }
  const native = found?.manifest.pi?.native?.find((entry) => entry.args?.includes("workflows")) ?? found?.manifest.pi?.native?.[0];
  if (native?.command && (await exists(native.command))) {
    return { installed: true, version, runner: { command: native.command, args: native.args ?? ["workflows"] }, error: null };
  }
  const onPath = which("pi-rust-ext");
  if (onPath) return { installed: Boolean(found), version, runner: { command: onPath, args: ["workflows"] }, error: null };
  return {
    installed: Boolean(found),
    version,
    runner: null,
    error: found
      ? "The workflows extension is installed, but its pi-rust-ext binary is missing. Run pi update --extensions."
      : "The workflows extension is not installed. Install marketplace:workflows on the Extensions tab.",
  };
}

async function spawnRunner(dir: string, cwd: string): Promise<void> {
  const { runner, error } = await workflowsExtension();
  if (!runner) throw new Error(error ?? "The workflows runner was not found.");
  const log = openSync(path.join(dir, "runner.log"), "w");
  try {
    const child = spawn(runner.command, [...runner.args, "--runner", dir], {
      cwd: (await exists(cwd)) ? cwd : undefined,
      env: piEnv(),
      detached: true,
      stdio: ["ignore", "ignore", log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (spawnError) => reject(new Error(`cannot start the runner: ${spawnError.message}`)));
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** A short id that sorts by start time: `wf-` and the time in base 36. */
async function newRunId(): Promise<string> {
  let ms = Date.now();
  for (;;) {
    const id = `wf-${ms.toString(36)}`;
    if (!(await exists(path.join(runsDir(), id)))) return id;
    ms += 1;
  }
}

function emptyStep(): Required<Omit<RawStep, "activity" | "writing">> {
  return { status: "pending", tasksDone: 0, runs: 0, startedMs: null, endedMs: null, summary: "", cost: 0, turns: 0, model: null, log: [] };
}

export interface StartRequest {
  workflow: Workflow;
  cwd: string;
  inputs: Record<string, string>;
  background: boolean;
  origin: "user" | "agent";
  agentId: string | null;
}

export async function startRun(request: StartRequest): Promise<string> {
  const { workflow, cwd } = request;
  const problems = workflowProblems(workflow);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (!(await exists(cwd))) throw new Error(`The directory ${cwd} does not exist.`);
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.inputs)) inputs[key] = value.trim();
  const missing = workflowInputs(workflow).filter((name) => !inputs[name]);
  if (missing.length > 0) throw new Error(`missing inputs: ${missing.join(", ")}`);
  const pi = requirePi();
  const catalog = await loadCatalog(cwd);
  const unknown = new Set<string>();
  for (const step of workflow.steps) {
    for (const skill of stepScope(workflow, step).skills ?? []) unknown.add(skill);
    for (const task of step.tasks) if (task.skill) unknown.add(task.skill);
  }
  const missingSkills = [...unknown].filter((name) => !catalog.skills[name]).sort();
  if (missingSkills.length > 0) throw new Error(`unknown skills: ${missingSkills.join(", ")}`);
  if (!(await workflowsExtension()).runner) throw new Error((await workflowsExtension()).error ?? "no runner");

  const id = await newRunId();
  const dir = path.join(runsDir(), id);
  await fs.mkdir(path.join(dir, "commands"), { recursive: true });
  await fs.writeFile(path.join(dir, "report.schema.json"), REPORT_SCHEMA);
  await fs.writeFile(path.join(dir, "plan.schema.json"), PLAN_SCHEMA);
  await fs.writeFile(path.join(dir, "memory.md"), "");
  const now = Date.now();
  const state = {
    id,
    workflow: normalizeWorkflow(workflow),
    inputs,
    cwd,
    origin: request.origin,
    status: "running",
    startedMs: now,
    endedMs: null,
    steps: workflow.steps.map(emptyStep),
    waitUntilMs: null,
    note: "",
    error: null,
    parentModel: catalog.parentModel,
    parentThinking: catalog.parentThinking,
    background: request.background,
    owner: process.pid,
    heartbeatMs: now,
    approval: null,
    pi,
    catalog: { skills: catalog.skills, mcpServers: catalog.mcpServers },
    ...(workflow.mode === "dynamic" ? { available: await plannerAvailable(cwd, catalog) } : {}),
  };
  await writeAtomic(path.join(dir, "run.json"), prettyJson(state));
  const link: PaseoLink = { agentId: request.agentId, origin: request.origin };
  await writeAtomic(path.join(dir, PASEO_FILE), prettyJson(link));
  touchLiveness();
  await spawnRunner(dir, cwd);
  return id;
}

/** Starts a new runner for a stopped, failed, or interrupted run at the task that did not finish. */
export async function resumeRun(id: string): Promise<void> {
  const { raw, dir } = await readRun(id);
  const status = raw.status ?? "running";
  if (isActive(status) && !stale(raw)) throw new Error(`Run ${id} is still ${status}.`);
  if (status === "done") throw new Error(`Run ${id} is done.`);
  const cwd = raw.cwd ?? process.cwd();
  const catalog = await loadCatalog(cwd);
  const now = Date.now();
  const steps = (raw.steps ?? []).map((step) => ({
    ...step,
    activity: undefined,
    writing: undefined,
    status: step.status === "failed" || step.status === "running" ? ("pending" as const) : step.status,
  }));
  const next: RawRun = {
    ...raw,
    note: isActive(status) ? "" : raw.note,
    status: "running",
    error: null,
    endedMs: null,
    approval: null,
    owner: process.pid,
    heartbeatMs: now,
    pi: piBinary() ?? raw.pi,
    catalog: { skills: catalog.skills, mcpServers: catalog.mcpServers },
    steps,
  };
  if (raw.workflow?.mode === "dynamic") next.available = await plannerAvailable(cwd, catalog);
  await writeAtomic(path.join(dir, "run.json"), prettyJson(next));
  touchLiveness();
  await spawnRunner(dir, cwd);
}

export async function startRunRpc(
  input: RpcInput<typeof runStartRpc>,
  paseo: PaseoApi | null,
): Promise<RpcOutput<typeof runStartRpc>> {
  let workflow: Workflow;
  if (input.workflow) {
    const parsed = parseWorkflow(input.workflow);
    if (!parsed.ok) throw new Error(parsed.error);
    workflow = parsed.workflow;
  } else if (input.name) {
    workflow = (await findWorkflow(input.name, input.definitionCwd ?? input.cwd, input.source)).workflow;
  } else {
    throw new Error("Name a saved workflow or pass a definition.");
  }
  workflow = resolveAskModels(workflow, input.models ?? {});
  const id = await startRun({
    workflow,
    cwd: input.cwd,
    inputs: input.inputs,
    background: input.background ?? (Boolean(workflow.background) || currentSettings().defaultBackground),
    origin: input.origin ?? "user",
    agentId: input.agentId ?? null,
  });
  if (input.agentId && paseo) await appendRunCard(paseo, input.agentId, id, workflow.name);
  return { id };
}

export async function appendRunCard(paseo: PaseoApi, agentId: string, runId: string, workflow: string): Promise<void> {
  try {
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: `run-${runId}`,
      kind: RUN_CARD_KIND,
      version: RUN_CARD_VERSION,
      data: { runId, workflow },
    });
  } catch (error) {
    console.error(`cannot add the run card to agent ${agentId}:`, (error as Error).message);
  }
}

// Reports -----------------------------------------------------------------------------------

/** The text an agent gets about its run: what each step did. */
export function runReport(run: RunDetail): string {
  const elapsed = formatDuration(((run.endedMs ?? Date.now()) - run.startedMs) / 1000);
  const cost = run.cost > 0 ? ` · $${run.cost.toFixed(2)}` : "";
  const label = run.status === "cancelled" ? "stopped" : run.status;
  const lines = [`Workflow ${run.workflow} (${run.id}) ${label} after ${elapsed}${cost}.`];
  if (run.error) lines.push(`Error: ${run.error}`);
  run.steps.forEach((step, index) => {
    const stepCost = step.cost > 0 ? ` · $${step.cost.toFixed(2)}` : "";
    lines.push(`${index + 1}. ${step.name}: ${step.status}${stepCost}${step.model ? ` · ${step.model}` : ""}`);
    if (step.summary) lines.push(`   ${step.summary.replace(/\n+/g, "\n   ")}`);
  });
  return lines.join("\n");
}

/** Claims the report of a run end, as pi sessions do, so each end is reported once. */
async function claimReport(dir: string, endedMs: number): Promise<boolean> {
  try {
    await (await fs.open(path.join(dir, `reported-${endedMs}`), "wx")).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Watches the runs Paseo started. When one that a Paseo agent started ends, it claims the report
 * and sends it to that agent, as pi reports a run to the agent that started it.
 */
export function startWatcher(getPaseo: () => PaseoApi | null): () => void {
  const checked = new Set<string>();
  let busy = false;
  const tick = async () => {
    touchLiveness();
    if (busy) return;
    busy = true;
    try {
      const paseo = getPaseo();
      for (const id of await listDir(runsDir())) {
        if (!id.startsWith("wf-")) continue;
        const dir = path.join(runsDir(), id);
        const link = await readJson<PaseoLink>(path.join(dir, PASEO_FILE)).catch(() => null);
        if (!link?.agentId) continue;
        const raw = await readJson<RawRun>(path.join(dir, "run.json")).catch(() => null);
        if (!raw || isActive(raw.status ?? "running") || raw.endedMs == null) continue;
        const key = `${id}:${raw.endedMs}`;
        if (checked.has(key)) continue;
        if (!paseo) continue;
        if (raw.owner !== process.pid && (await ownerAlive(raw.owner ?? 0))) continue;
        checked.add(key);
        if (!(await claimReport(dir, raw.endedMs))) continue;
        await appendRunCard(paseo, link.agentId, id, raw.workflow?.name ?? id);
        if (link.origin === "agent" && currentSettings().reportToAgent) {
          const { run } = await getRun({ id });
          await paseo.agents
            .ref(link.agentId)
            .send(runReport(run))
            .catch((error: Error) => console.error(`cannot report run ${id} to agent ${link.agentId}:`, error.message));
        }
      }
    } catch (error) {
      console.error("run watcher:", (error as Error).message);
    } finally {
      busy = false;
    }
  };
  touchLiveness();
  const timer = setInterval(() => void tick(), TOUCH_EVERY_MS);
  return () => {
    clearInterval(timer);
  };
}

/** When the plugin stops, its foreground runs stop as interrupted, as when pi quits. */
export async function releaseRuns(): Promise<void> {
  for (const id of await listDir(runsDir())) {
    if (!id.startsWith("wf-")) continue;
    const raw = await readJson<RawRun>(path.join(runsDir(), id, "run.json")).catch(() => null);
    if (!raw || raw.owner !== process.pid || raw.background || !isActive(raw.status ?? "running")) continue;
    await sendCommand(id, { type: "interrupt" }).catch(() => {});
  }
  await fs.rm(livenessFile(), { force: true }).catch(() => {});
}

export async function activeCounts(): Promise<{ active: number; approvals: number }> {
  const { runs } = await listRuns({ limit: 1000 });
  return {
    active: runs.filter((run) => isActive(run.status) && !run.stale).length,
    approvals: runs.filter((run) => isActive(run.status) && !run.stale && run.approval).length,
  };
}
