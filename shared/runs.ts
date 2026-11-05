// Run state as the `workflows` runner writes it to `<agentDir>/ext/workflows/runs/<id>/run.json`
// (extensions/workflows/src/runs.rs), reduced to what the plugin shows.
import { z } from "zod";

export const RUN_STATUSES = ["running", "waiting", "done", "failed", "cancelled", "interrupted"] as const;
export const STEP_STATUSES = ["pending", "running", "done", "failed"] as const;
export const OUTPUT_KINDS = ["prompt", "user", "assistant", "tool", "error"] as const;
export const DECISIONS = ["run", "skip", "stop"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Decision = (typeof DECISIONS)[number];

/** An active run without a heartbeat for this long has lost its runner. */
export const STALE_MS = 30_000;

export function isActive(status: RunStatus): boolean {
  return status === "running" || status === "waiting";
}

/** The labels the TUI uses: `cancelled` shows as `stopped`. */
export function statusLabel(status: RunStatus, stale: boolean): string {
  if (stale) return "stale";
  return status === "cancelled" ? "stopped" : status;
}

export const ApprovalSchema = z.object({
  task: z.string(),
  step: z.number(),
  askedMs: z.number(),
});

export const StepRunSchema = z.object({
  name: z.string(),
  status: z.enum(STEP_STATUSES),
  tasksDone: z.number(),
  taskCount: z.number(),
  runs: z.number(),
  startedMs: z.number().nullable(),
  endedMs: z.number().nullable(),
  summary: z.string(),
  cost: z.number(),
  turns: z.number(),
  model: z.string().nullable(),
  log: z.array(z.string()),
  activity: z.string(),
  writing: z.string(),
});

export const RunSummarySchema = z.object({
  id: z.string(),
  workflow: z.string(),
  description: z.string(),
  mode: z.string(),
  status: z.enum(RUN_STATUSES),
  stale: z.boolean(),
  cwd: z.string(),
  origin: z.string(),
  startedMs: z.number(),
  endedMs: z.number().nullable(),
  waitUntilMs: z.number().nullable(),
  note: z.string(),
  error: z.string().nullable(),
  background: z.boolean(),
  owner: z.number(),
  /** The run's owner is this plugin process. */
  ownedHere: z.boolean(),
  approval: ApprovalSchema.nullable(),
  cost: z.number(),
  stepCount: z.number(),
  stepsDone: z.number(),
  /** Index of the step that runs now, or the first unfinished one. */
  currentStep: z.number().nullable(),
  /** Index of the step whose agent works now. */
  agentStep: z.number().nullable(),
  currentStepName: z.string().nullable(),
  activity: z.string(),
  inputs: z.record(z.string(), z.string()),
  /** The Paseo agent that started the run, when one did. */
  paseoAgentId: z.string().nullable(),
});

export const RunDetailSchema = RunSummarySchema.extend({
  steps: z.array(StepRunSchema),
  definition: z.record(z.string(), z.unknown()),
  parentModel: z.string().nullable(),
  parentThinking: z.string().nullable(),
  pi: z.string(),
  dir: z.string(),
});

export const OutputEntrySchema = z.object({
  kind: z.string(),
  text: z.string(),
});

export type Approval = z.infer<typeof ApprovalSchema>;
export type StepRun = z.infer<typeof StepRunSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type OutputEntry = z.infer<typeof OutputEntrySchema>;

export function costLabel(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(2)}` : "";
}
