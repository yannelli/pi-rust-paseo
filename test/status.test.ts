// Background tasks, timers, goals, and per-agent summaries from extension files in a temporary
// agent directory, with a real detached process for the running task.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pluginSettings } from "../shared/contracts";
import { pillLabel, pillVisible } from "../shared/status";
import { applySettings } from "../server/pi";
import { agentStatus, projectSlug, readGoals, readTasks, readTimers, statusSummary, stopTask, taskLog } from "../server/status";

const root = mkdtempSync(path.join(tmpdir(), "pi-rust-status-"));
const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
const session = "01a1aaaa-0000-7000-8000-000000000001";
const tasks = path.join(agentDir, "ext", "background-tasks", "sessions", session);
let sleeper: ReturnType<typeof spawn> | null = null;

function lstart(pid: number): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, encoding: "utf8" }).trim().split(/\s+/).join(" ");
}

function task(id: string, fields: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = path.join(tasks, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id, name: `task ${id}`, command: "echo hi", cwd: project, isAgent: false, startedAt: Date.now() - 60_000, ...fields }));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
}

const paseo = {
  agents: {
    list: async () => ({
      entries: [
        { agent: { id: "pi-agent", provider: "pi", cwd: project, workspaceId: "wks-1", persistence: { provider: "pi", sessionId: session } } },
        { agent: { id: "claude-agent", provider: "claude", cwd: project, workspaceId: "wks-1", persistence: { provider: "claude", sessionId: "x" } } },
        { agent: { id: "idle-claude", provider: "claude", cwd: "/elsewhere", workspaceId: "wks-2" } },
        { agent: { id: "archived", provider: "pi", cwd: project, workspaceId: "wks-1", archivedAt: "2026-01-01" } },
      ],
    }),
    ref: (id: string) => ({
      refresh: async () => null,
      current: () => ({ id, provider: "pi", cwd: project, workspaceId: "wks-1", persistence: { provider: "pi", sessionId: session } }),
    }),
  },
} as never;

before(async () => {
  mkdirSync(project, { recursive: true });
  applySettings({ ...pluginSettings.schema.parse({}), agentDir });
  sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => sleeper!.once("spawn", resolve));
  const pid = sleeper.pid!;
  task("run1", { pid, processStart: lstart(pid), status: "running", description: "Long build" }, { "output.log": "line 1\nline 2\n" });
  task("done1", { status: "completed", exitCode: 0, endedAt: Date.now() - 30_000 }, { "output.log": "ok\n" });
  task("exit1", { pid: 1, processStart: "Thu Jan 1 00:00:00 1970", status: "running" }, { exit: "1\n" });
  task("gone1", { pid: 999_999, processStart: "Thu Jan 1 00:00:00 1970", status: "running" });
  mkdirSync(path.join(agentDir, "ext", "timers", "sessions"), { recursive: true });
  writeFileSync(
    path.join(agentDir, "ext", "timers", "sessions", `${session}.json`),
    JSON.stringify({
      heartbeats: [{ id: "h1", reason: "watch CI", everySecs: 900, pulses: 2, maxPulses: 5, nextAt: Date.now() + 60_000 }],
      schedules: [{ id: "s1", name: "nightly", prompt: "run the suite", trigger: { kind: "cron", expr: "0 3 * * *" }, runs: 0, nextAt: Date.now() + 3_600_000 }],
    }),
  );
  const goals = path.join(agentDir, "ext", "goal", "projects", projectSlug(project));
  mkdirSync(goals, { recursive: true });
  writeFileSync(
    path.join(goals, "g1.json"),
    JSON.stringify({
      id: "g1",
      objective: "=== Goal ===\nObjective: Ship rate limiting\n\nSuccess criteria: ...",
      status: "active",
      tasks: [
        { id: "a", title: "Design", status: "complete" },
        { id: "b", title: "Implement", status: "in_progress" },
        { id: "c", title: "Verify", status: "pending" },
      ],
      currentTaskId: "b",
      updatedAt: Date.now(),
    }),
  );
  writeFileSync(path.join(goals, "g0.json"), JSON.stringify({ id: "g0", objective: "Objective: done", status: "complete", tasks: [] }));
});

after(() => {
  try {
    process.kill(-sleeper!.pid!, "SIGKILL");
  } catch {
    // Already stopped by the test.
  }
});

test("goal directories use the extension's slug", () => {
  assert.equal(projectSlug("/Users/ada/.paseo/worktrees/k3x9/brave-otter"), "Users-ada--paseo-worktrees-k3x9-brave-otter");
  assert.equal(projectSlug("/"), "root");
});

test("background tasks report their real state", async () => {
  const list = await readTasks(session);
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.equal(list[0].id, "run1");
  assert.equal(byId.run1.status, "running");
  assert.equal(byId.done1.status, "completed");
  assert.equal(byId.exit1.status, "failed");
  assert.equal(byId.exit1.exitCode, 1);
  assert.equal(byId.gone1.status, "lost");
  assert.deepEqual(await taskLog({ sessionId: session, taskId: "run1" }), { text: "line 1\nline 2\n", bytes: 14, truncated: false });
  await assert.rejects(readTasks("../escape"), /Invalid session id/);
});

test("timers and open goals", async () => {
  const timers = await readTimers(session);
  assert.deepEqual(
    timers.map((t) => [t.kind, t.label, t.detail, t.count, t.max]),
    [
      ["heartbeat", "watch CI", "every 15m", 2, 5],
      ["schedule", "nightly", "cron 0 3 * * *", 0, null],
    ],
  );
  const goals = await readGoals(project);
  assert.equal(goals.length, 1);
  assert.equal(goals[0].title, "Ship rate limiting");
  assert.deepEqual([goals[0].tasksDone, goals[0].taskCount, goals[0].currentTask], [1, 3, "Implement"]);
});

test("summaries per agent drive the composer pill", async () => {
  const { agents } = await statusSummary(paseo);
  const pi = agents.find((a) => a.agentId === "pi-agent")!;
  assert.deepEqual(pi.tasks, { running: 1, failed: 2, total: 4 });
  assert.equal(pi.timers, 2);
  assert.deepEqual(pi.goal, { status: "active", done: 1, total: 3 });
  assert.equal(pillLabel(pi), "1 bg · goal 1/3 · 2 timers");
  assert.equal(pillLabel({ ...pi, runs: { active: 2, approvals: 1 } }), "Approve · 1 bg · 2 runs");
  assert.equal(pillLabel({ ...pi, tasks: { running: 0, failed: 0, total: 0 }, timers: 0, goal: null }), "Pi Rust");
  assert.equal(pillVisible(pi), true);
  const claude = agents.find((a) => a.agentId === "claude-agent")!;
  assert.deepEqual([claude.isPi, claude.tasks.total, claude.goal], [false, 0, null]);
  assert.equal(pillVisible(claude), false);
  assert.equal(agents.some((a) => a.agentId === "archived"), false);
  const full = await agentStatus({ agentId: "pi-agent" }, paseo);
  assert.equal(full.agent.sessionId, session);
  assert.equal(full.tasks.length, 4);
  assert.equal(full.goals.length, 1);
});

test("stopping a task signals its process group and records it", async () => {
  const exited = new Promise((resolve) => sleeper!.once("exit", resolve));
  assert.equal((await stopTask({ sessionId: session, taskId: "run1" })).message, "Stopped task run1.");
  await exited;
  const saved = JSON.parse(readFileSync(path.join(tasks, "run1", "task.json"), "utf8")) as { status: string; error: string };
  assert.deepEqual([saved.status, saved.error], ["killed", "stopped from Paseo"]);
  await assert.rejects(stopTask({ sessionId: session, taskId: "run1" }), /not running/);
});
