// Live status of the pi work around an agent: background tasks, timers, goals, and workflow runs.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RunSummarySchema } from "./runs";

export const BG_STATUSES = ["running", "completed", "failed", "killed", "timed_out", "lost"] as const;
export type BgStatus = (typeof BG_STATUSES)[number];

export const BgTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(BG_STATUSES),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  timeoutSeconds: z.number().nullable(),
  isAgent: z.boolean(),
  outputBytes: z.number(),
});
export type BgTask = z.infer<typeof BgTaskSchema>;

export const TimerSchema = z.object({
  id: z.string(),
  kind: z.enum(["heartbeat", "schedule"]),
  label: z.string(),
  detail: z.string(),
  nextAt: z.number().nullable(),
  count: z.number(),
  max: z.number().nullable(),
});
export type Timer = z.infer<typeof TimerSchema>;

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  tasksDone: z.number(),
  taskCount: z.number(),
  currentTask: z.string().nullable(),
  waitReason: z.string().nullable(),
  waitUntil: z.number().nullable(),
  activeSeconds: z.number().nullable(),
  tokensUsed: z.number().nullable(),
  updatedAt: z.number().nullable(),
});
export type Goal = z.infer<typeof GoalSchema>;

/** The counts a composer pill shows for one agent. */
export const AgentStatusSummarySchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  /** pi or pi-rust: the agent has a pi session with background tasks and timers. */
  isPi: z.boolean(),
  tasks: z.object({ running: z.number(), failed: z.number(), total: z.number() }),
  timers: z.number(),
  goal: z.object({ status: z.string(), done: z.number(), total: z.number() }).nullable(),
  runs: z.object({ active: z.number(), approvals: z.number() }),
});
export type AgentStatusSummary = z.infer<typeof AgentStatusSummarySchema>;

export const statusSummaryRpc = defineRpc({
  name: "status.summary",
  input: z.object({}),
  output: z.object({ agents: z.array(AgentStatusSummarySchema) }),
});

export const agentStatusRpc = defineRpc({
  name: "status.agent",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    agent: z.object({ id: z.string(), provider: z.string(), cwd: z.string(), sessionId: z.string().nullable(), isPi: z.boolean() }),
    tasks: z.array(BgTaskSchema),
    timers: z.array(TimerSchema),
    goals: z.array(GoalSchema),
    runs: z.array(RunSummarySchema),
  }),
});

export const taskLogRpc = defineRpc({
  name: "status.task.log",
  input: z.object({ sessionId: z.string().min(1), taskId: z.string().min(1), maxBytes: z.number().int().positive().optional() }),
  output: z.object({ text: z.string(), bytes: z.number(), truncated: z.boolean() }),
});

export const taskStopRpc = defineRpc({
  name: "status.task.stop",
  input: z.object({ sessionId: z.string().min(1), taskId: z.string().min(1) }),
  output: z.object({ message: z.string() }),
});

/** Background tasks that ended badly within this window still count on the pill. */
export const RECENT_FAILURE_MS = 30 * 60_000;

export function isBad(status: BgStatus): boolean {
  return status === "failed" || status === "timed_out" || status === "lost";
}

export function bgLabel(status: BgStatus): string {
  return status === "timed_out" ? "timed out" : status === "killed" ? "stopped" : status;
}

/** The short label of a composer pill: what needs you, then what runs, at most three parts. */
export function pillLabel(summary: AgentStatusSummary): string {
  const parts: string[] = [];
  if (summary.runs.approvals > 0) parts.push(summary.runs.approvals === 1 ? "Approve" : `Approve ${summary.runs.approvals}`);
  if (summary.tasks.running > 0) parts.push(`${summary.tasks.running} bg`);
  if (summary.runs.active > 0) parts.push(`${summary.runs.active} run${summary.runs.active === 1 ? "" : "s"}`);
  if (summary.goal && summary.goal.status !== "complete") parts.push(summary.goal.total ? `goal ${summary.goal.done}/${summary.goal.total}` : "goal");
  if (summary.timers > 0) parts.push(`${summary.timers} timer${summary.timers === 1 ? "" : "s"}`);
  if (summary.tasks.failed > 0) parts.push(`${summary.tasks.failed} failed`);
  return parts.length ? parts.slice(0, 3).join(" · ") : "Pi Rust";
}

/** Whether the pill has anything to show; pi agents always show it as their status hub. */
export function pillVisible(summary: AgentStatusSummary): boolean {
  return (
    summary.isPi ||
    summary.runs.active > 0 ||
    summary.runs.approvals > 0 ||
    summary.tasks.running > 0 ||
    summary.tasks.failed > 0 ||
    summary.timers > 0 ||
    (summary.goal !== null && summary.goal.status !== "complete")
  );
}
