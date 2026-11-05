// What runs around each agent, from the files of pi's extensions: background tasks
// (ext/background-tasks/sessions/<session>/<task>/task.json), timers
// (ext/timers/sessions/<session>.json), goals (ext/goal/projects/<cwd slug>/*.json), and
// workflow runs. A Paseo pi agent's persistence session id is its pi session id.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { isActive, type RunSummary } from "../shared/runs";
import {
  RECENT_FAILURE_MS,
  isBad,
  type agentStatusRpc,
  type AgentStatusSummary,
  type BgStatus,
  type BgTask,
  type Goal,
  type taskLogRpc,
  type taskStopRpc,
  type Timer,
} from "../shared/status";
import { exists, listDir, readJson, readTail, readText, writeAtomic, prettyJson } from "./fsutil";
import { agentDir } from "./pi";
import { listRuns } from "./runs";

interface AgentInfo {
  id: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  sessionId: string | null;
  isPi: boolean;
}

interface RawAgent {
  id: string;
  provider?: string;
  cwd?: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  internal?: boolean;
  persistence?: { provider?: string; sessionId?: string } | null;
}

function toAgent(raw: RawAgent): AgentInfo {
  const provider = raw.provider ?? "";
  const isPi = provider === "pi" || provider === "pi-rust" || provider.startsWith("pi/") || (raw.persistence?.provider ?? "").startsWith("pi");
  return {
    id: raw.id,
    workspaceId: raw.workspaceId ?? null,
    provider,
    cwd: raw.cwd ?? "",
    sessionId: isPi ? (raw.persistence?.sessionId ?? null) : null,
    isPi,
  };
}

async function activeAgents(paseo: PaseoApi): Promise<AgentInfo[]> {
  const result = await paseo.agents.list({ scope: "active", page: { limit: 200 } });
  return result.entries
    .map((entry) => (entry as unknown as { agent: RawAgent }).agent)
    .filter((agent) => agent && !agent.archivedAt && !agent.internal)
    .map(toAgent);
}

async function findAgent(paseo: PaseoApi, agentId: string): Promise<AgentInfo> {
  const handle = paseo.agents.ref(agentId);
  await handle.refresh();
  const snapshot = handle.current() as unknown as RawAgent | null;
  if (!snapshot) throw new Error(`No agent ${agentId}.`);
  return toAgent(snapshot);
}

// Background tasks ----------------------------------------------------------------------------

function tasksDir(sessionId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error(`Invalid session id ${sessionId}.`);
  return path.join(agentDir(), "ext", "background-tasks", "sessions", sessionId);
}

function normalize(text: string): string {
  return text.trim().split(/\s+/).join(" ");
}

/** Start times of all processes, as `ps -o lstart` prints them; null where `ps` is unavailable. */
function processStarts(): Promise<Map<number, string> | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,lstart="], { env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      const map = new Map<number, string>();
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match) map.set(Number(match[1]), normalize(match[2]));
      }
      resolve(map);
    });
  });
}

interface RawTask {
  id?: string;
  name?: string;
  description?: string;
  command?: string;
  cwd?: string;
  isAgent?: boolean;
  pid?: number;
  processStart?: string;
  startedAt?: number;
  endedAt?: number | null;
  timeoutSeconds?: number | null;
  status?: string;
  exitCode?: number | null;
  error?: string;
}

/** A recorded `running` task is finished when its exit file exists, and lost when its process is gone. */
async function effectiveStatus(raw: RawTask, dir: string, starts: Map<number, string> | null): Promise<{ status: BgStatus; exitCode: number | null }> {
  const recorded = (raw.status ?? "running") as BgStatus;
  if (recorded !== "running") return { status: recorded, exitCode: raw.exitCode ?? null };
  const exit = await readText(path.join(dir, "exit")).catch(() => null);
  if (exit !== null && exit.trim() !== "") {
    const code = Number(exit.trim());
    return { status: code === 0 ? "completed" : "failed", exitCode: Number.isFinite(code) ? code : null };
  }
  if (!starts || !raw.pid) return { status: "running", exitCode: null };
  const start = starts.get(raw.pid);
  const alive = start !== undefined && (!raw.processStart || start === normalize(raw.processStart));
  return { status: alive ? "running" : "lost", exitCode: null };
}

export async function readTasks(sessionId: string, starts?: Map<number, string> | null): Promise<BgTask[]> {
  const root = tasksDir(sessionId);
  const ids = await listDir(root);
  if (ids.length === 0) return [];
  const pids = starts === undefined ? await processStarts() : starts;
  const tasks: BgTask[] = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    const raw = await readJson<RawTask>(path.join(dir, "task.json")).catch(() => null);
    if (!raw) continue;
    const { status, exitCode } = await effectiveStatus(raw, dir, pids);
    const size = await fs.stat(path.join(dir, "output.log")).then((s) => s.size).catch(() => 0);
    tasks.push({
      id: raw.id ?? id,
      name: raw.name ?? id,
      description: raw.description ?? "",
      command: raw.command ?? "",
      cwd: raw.cwd ?? "",
      status,
      exitCode,
      error: raw.error ?? null,
      startedAt: raw.startedAt ?? null,
      endedAt: raw.endedAt ?? null,
      timeoutSeconds: raw.timeoutSeconds ?? null,
      isAgent: Boolean(raw.isAgent),
      outputBytes: size,
    });
  }
  // Running first, then newest.
  tasks.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return tasks;
}

export async function taskLog({ sessionId, taskId, maxBytes }: RpcInput<typeof taskLogRpc>): Promise<RpcOutput<typeof taskLogRpc>> {
  const file = path.join(tasksDir(sessionId), path.basename(taskId), "output.log");
  const limit = Math.min(maxBytes ?? 16_384, 50_000);
  const bytes = await fs.stat(file).then((s) => s.size).catch(() => 0);
  return { text: await readTail(file, limit), bytes, truncated: bytes > limit };
}

/** Stops a running task's process group as bg_kill does: TERM, then KILL after 3 seconds. */
export async function stopTask({ sessionId, taskId }: RpcInput<typeof taskStopRpc>): Promise<RpcOutput<typeof taskStopRpc>> {
  const dir = path.join(tasksDir(sessionId), path.basename(taskId));
  const raw = await readJson<RawTask>(path.join(dir, "task.json"));
  if (!raw) throw new Error(`No background task ${taskId}.`);
  const starts = await processStarts();
  const { status } = await effectiveStatus(raw, dir, starts);
  if (status !== "running" || !raw.pid) throw new Error(`Task ${raw.name ?? taskId} is not running.`);
  if (starts && raw.processStart && starts.get(raw.pid) !== normalize(raw.processStart)) {
    throw new Error(`The process of ${raw.name ?? taskId} is gone.`);
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-raw.pid!, sig);
    } catch {
      try {
        process.kill(raw.pid!, sig);
      } catch {
        // Already gone.
      }
    }
  };
  const leaderStart = starts?.get(raw.pid) ?? null;
  signal("SIGTERM");
  // KILL only when the same leader process still runs, so a reused pid is never signalled.
  setTimeout(() => {
    void processStarts().then((later) => {
      if (later && leaderStart && later.get(raw.pid!) === leaderStart) signal("SIGKILL");
    });
  }, 3000).unref();
  await writeAtomic(path.join(dir, "task.json"), prettyJson({ ...raw, status: "killed", endedAt: Date.now(), error: "stopped from Paseo" }));
  return { message: `Stopped ${raw.name ?? taskId}.` };
}

// Timers --------------------------------------------------------------------------------------

interface RawTimers {
  heartbeats?: { id: string; name?: string; reason?: string; everySecs?: number; maxPulses?: number | null; pulses?: number; nextAt?: number }[];
  schedules?: { id: string; name?: string; prompt?: string; trigger?: { kind: string; at?: number; secs?: number; expr?: string }; maxRuns?: number | null; runs?: number; nextAt?: number }[];
}

function every(secs: number): string {
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

export async function readTimers(sessionId: string): Promise<Timer[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) return [];
  const raw = await readJson<RawTimers>(path.join(agentDir(), "ext", "timers", "sessions", `${sessionId}.json`)).catch(() => null);
  if (!raw) return [];
  const timers: Timer[] = [];
  for (const beat of raw.heartbeats ?? []) {
    timers.push({
      id: beat.id,
      kind: "heartbeat",
      label: beat.name || beat.reason || beat.id,
      detail: `every ${every(beat.everySecs ?? 0)}${beat.reason && beat.name ? ` · ${beat.reason}` : ""}`,
      nextAt: beat.nextAt ?? null,
      count: beat.pulses ?? 0,
      max: beat.maxPulses ?? null,
    });
  }
  for (const schedule of raw.schedules ?? []) {
    const trigger = schedule.trigger;
    const when = !trigger ? "" : trigger.kind === "every" ? `every ${every(trigger.secs ?? 0)}` : trigger.kind === "cron" ? `cron ${trigger.expr ?? ""}` : "once";
    timers.push({
      id: schedule.id,
      kind: "schedule",
      label: schedule.name || (schedule.prompt ?? schedule.id).slice(0, 80),
      detail: when,
      nextAt: schedule.nextAt ?? null,
      count: schedule.runs ?? 0,
      max: schedule.maxRuns ?? null,
    });
  }
  return timers;
}

// Goals ---------------------------------------------------------------------------------------

/** The goal extension's directory name for a working directory. */
export function projectSlug(cwd: string): string {
  const slug = [...cwd].map((c) => (/[A-Za-z0-9]/.test(c) ? c : "-")).join("").replace(/^-+|-+$/g, "");
  return slug || "root";
}

interface RawGoal {
  id?: string;
  objective?: string;
  status?: string;
  tasks?: { id: string; title?: string; status?: string }[];
  currentTaskId?: string | null;
  wait?: { reason?: string; deadline?: string | number } | null;
  usage?: { tokensUsed?: number; activeSeconds?: number };
  updatedAt?: number;
}

function goalTitle(objective: string): string {
  const line = /Objective:\s*(.+)/.exec(objective)?.[1] ?? objective.split("\n").find((l) => l.trim() && !l.startsWith("==="));
  const text = (line ?? objective).trim();
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

export async function readGoals(cwd: string): Promise<Goal[]> {
  if (!cwd) return [];
  const dir = path.join(agentDir(), "ext", "goal", "projects", projectSlug(path.resolve(cwd)));
  const goals: Goal[] = [];
  for (const file of await listDir(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = await readJson<RawGoal>(path.join(dir, file)).catch(() => null);
    if (!raw || raw.status === "complete") continue;
    const tasks = raw.tasks ?? [];
    const deadline = raw.wait?.deadline;
    goals.push({
      id: raw.id ?? file.replace(/\.json$/, ""),
      title: goalTitle(raw.objective ?? ""),
      status: raw.status ?? "active",
      tasksDone: tasks.filter((t) => t.status === "complete" || t.status === "skipped").length,
      taskCount: tasks.length,
      currentTask: tasks.find((t) => t.id === raw.currentTaskId)?.title ?? null,
      waitReason: raw.wait?.reason ?? null,
      waitUntil: typeof deadline === "number" ? deadline : deadline ? Date.parse(deadline) || null : null,
      activeSeconds: raw.usage?.activeSeconds ?? null,
      tokensUsed: raw.usage?.tokensUsed ?? null,
      updatedAt: raw.updatedAt ?? null,
    });
  }
  goals.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return goals;
}

// Runs and summaries --------------------------------------------------------------------------

function within(dir: string, parent: string): boolean {
  if (!dir || !parent) return false;
  const a = path.resolve(dir);
  const b = path.resolve(parent);
  return a === b || a.startsWith(`${b}${path.sep}`);
}

function runsFor(agent: AgentInfo, runs: RunSummary[]): RunSummary[] {
  return runs.filter((run) => run.paseoAgentId === agent.id || within(run.cwd, agent.cwd));
}

export async function statusSummary(paseo: PaseoApi | null): Promise<{ agents: AgentStatusSummary[] }> {
  if (!paseo) return { agents: [] };
  const [agents, { runs }, starts] = await Promise.all([activeAgents(paseo), listRuns({ limit: 300 }), processStarts()]);
  const now = Date.now();
  const out: AgentStatusSummary[] = [];
  const goalCache = new Map<string, Goal[]>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    const tasks = agent.sessionId ? await readTasks(agent.sessionId, starts) : [];
    const timers = agent.sessionId ? await readTimers(agent.sessionId) : [];
    let goals: Goal[] = [];
    if (agent.isPi) {
      goals = goalCache.get(agent.cwd) ?? (await readGoals(agent.cwd));
      goalCache.set(agent.cwd, goals);
    }
    const mine = runsFor(agent, runs).filter((run) => isActive(run.status) && !run.stale);
    const goal = goals[0] ?? null;
    out.push({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      isPi: agent.isPi,
      tasks: {
        running: tasks.filter((t) => t.status === "running").length,
        failed: tasks.filter((t) => isBad(t.status) && now - (t.endedAt ?? t.startedAt ?? 0) < RECENT_FAILURE_MS).length,
        total: tasks.length,
      },
      timers: timers.length,
      goal: goal ? { status: goal.status, done: goal.tasksDone, total: goal.taskCount } : null,
      runs: { active: mine.length, approvals: mine.filter((run) => run.approval).length },
    });
  }
  return { agents: out };
}

export async function agentStatus({ agentId }: RpcInput<typeof agentStatusRpc>, paseo: PaseoApi | null): Promise<RpcOutput<typeof agentStatusRpc>> {
  if (!paseo) throw new Error("The plugin has no daemon session yet.");
  const agent = await findAgent(paseo, agentId);
  const { runs } = await listRuns({ limit: 300 });
  const mine = runsFor(agent, runs);
  const active = mine.filter((run) => isActive(run.status) && !run.stale);
  const recent = mine.filter((run) => !active.includes(run)).slice(0, 5);
  return {
    agent: { id: agent.id, provider: agent.provider, cwd: agent.cwd, sessionId: agent.sessionId, isPi: agent.isPi },
    tasks: agent.sessionId ? await readTasks(agent.sessionId) : [],
    timers: agent.sessionId ? await readTimers(agent.sessionId) : [],
    goals: agent.isPi && (await exists(agent.cwd)) ? await readGoals(agent.cwd) : [],
    runs: [...active, ...recent],
  };
}
