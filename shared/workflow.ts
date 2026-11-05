// The workflow file format of the pi-rust `workflows` extension (extensions/workflows/src/model.rs).
// Field names, defaults, and validation messages match the extension so files round-trip.
import { z } from "zod";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const CONTEXT_MODES = ["handoff", "memory", "session", "none"] as const;
export const MODES = ["fixed", "dynamic"] as const;
/** The model value that makes the run dialog ask for a model. */
export const ASK = "ask";
/** The model and thinking level that new workflows and model pickers start with. */
export const DEFAULT_MODEL = "anthropic/claude-opus-5-5";
export const DEFAULT_THINKING = "medium";

export type ContextMode = (typeof CONTEXT_MODES)[number];
export type Mode = (typeof MODES)[number];

export const CONTEXT_DESCRIPTIONS: Record<ContextMode, string> = {
  handoff: "each agent gets the reports of the earlier steps",
  memory: "reports plus a shared notes file that every agent adds to",
  session: "all steps continue one conversation",
  none: "each agent sees only its own tasks",
};

// serde `deny_unknown_fields` on every struct: unknown fields are errors.
export const SubagentRuleSchema = z
  .object({
    agent: z.string().default(""),
    models: z.array(z.string()).optional(),
    thinking: z.array(z.string()).optional(),
  })
  .strict();

export const ScopeSchema = z
  .object({
    model: z.string().optional(),
    thinking: z.string().optional(),
    tools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    subagents: z.array(SubagentRuleSchema).optional(),
    env: z.record(z.string(), z.string()).optional(),
    systemPrompt: z.string().optional(),
    maxTurns: z.number().int().nonnegative().optional(),
    maxCost: z.number().optional(),
  })
  .strict();

export const TaskSchema = z
  .object({
    prompt: z.string().default(""),
    skill: z.string().optional(),
    delay: z.string().optional(),
    repeat: z.number().int().nonnegative().optional(),
    every: z.string().optional(),
    until: z.string().optional(),
    confirm: z.boolean().optional(),
    optional: z.boolean().optional(),
  })
  .strict();

export const StepSchema = z
  .object({
    name: z.string().default(""),
    context: z.enum(CONTEXT_MODES).optional(),
    agent: ScopeSchema.optional(),
    tasks: z.array(TaskSchema).default([]),
  })
  .strict();

export const PlannerSchema = z
  .object({
    instructions: z.string().optional(),
    model: z.string().optional(),
    maxSteps: z.number().int().nonnegative().optional(),
  })
  .strict();

export const WorkflowSchema = z
  .object({
    name: z.string().default(""),
    description: z.string().optional(),
    mode: z.enum(MODES).optional(),
    context: z.enum(CONTEXT_MODES).optional(),
    background: z.boolean().optional(),
    agent: ScopeSchema.optional(),
    planner: PlannerSchema.optional(),
    steps: z.array(StepSchema).default([]),
  })
  .strict();

export type SubagentRule = z.infer<typeof SubagentRuleSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Planner = z.infer<typeof PlannerSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

/** JSON that crosses the RPC boundary; the receiver parses it with `parseWorkflow`. */
export const WorkflowJsonSchema = z.record(z.string(), z.unknown());

export type ParsedWorkflow = { ok: true; workflow: Workflow } | { ok: false; error: string };

export function parseWorkflow(value: unknown): ParsedWorkflow {
  const parsed = WorkflowSchema.safeParse(value);
  if (parsed.success) return { ok: true, workflow: parsed.data };
  const error = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "workflow";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
  return { ok: false, error };
}

export function parseWorkflowText(text: string): ParsedWorkflow {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  return parseWorkflow(value);
}

/** Lowercase letters, digits, and single dashes: the file and session name of a workflow or step. */
export function slug(name: string): string {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    if (/^[a-z0-9_]$/.test(c)) out += c;
    else if (out.length > 0 && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "");
}

/** `30s`, `5m`, `1h30m`, `2d`, or plain seconds; null when the text is not a duration. */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.length === 0) return null;
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  let total = 0;
  let number = "";
  for (const c of trimmed) {
    if (c >= "0" && c <= "9") {
      number += c;
      continue;
    }
    const unit = units[c];
    if (unit === undefined || number.length === 0) return null;
    total += Number(number) * unit;
    number = "";
  }
  return number.length === 0 ? total : null;
}

/** `1h30m`, `5m`, `45s`, `0s`. */
export function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor(secs / 60) % 60;
  const s = secs % 60;
  let out = "";
  if (h > 0) out += `${h}h`;
  if (m > 0) out += `${m}m`;
  if (s > 0 || out.length === 0) out += `${s}s`;
  return out;
}

/** `{{ name }}` placeholders in `text`. */
export function placeholders(text: string): string[] {
  const names: string[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) break;
    const name = after.slice(0, end).trim();
    if (name.length > 0 && /^[A-Za-z0-9_-]+$/.test(name)) names.push(name);
    rest = after.slice(end + 2);
  }
  return names;
}

/** The `{{name}}` placeholders of all prompts, in order of first use. Dynamic workflows always have `goal`. */
export function workflowInputs(workflow: Workflow): string[] {
  const names: string[] = [];
  if (workflow.mode === "dynamic") names.push("goal");
  const texts: string[] = [workflow.planner?.instructions ?? ""];
  if (workflow.agent?.systemPrompt !== undefined) texts.push(workflow.agent.systemPrompt);
  for (const step of workflow.steps) {
    if (step.agent?.systemPrompt !== undefined) texts.push(step.agent.systemPrompt);
    for (const task of step.tasks) {
      texts.push(task.prompt);
      if (task.until !== undefined) texts.push(task.until);
    }
  }
  for (const text of texts) {
    for (const name of placeholders(text)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function checkModel(label: string, model: string, problems: string[]) {
  const slash = model.indexOf("/");
  const valid = model === ASK || (slash > 0 && slash < model.length - 1);
  if (!valid) problems.push(`${label}: model ${JSON.stringify(model)} must be provider/id or "ask"`);
}

function checkScope(label: string, scope: Scope | undefined, problems: string[]) {
  if (!scope) return;
  if (scope.model !== undefined) checkModel(label, scope.model, problems);
  if (scope.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(scope.thinking)) {
    problems.push(`${label}: thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (scope.maxCost !== undefined && scope.maxCost <= 0) problems.push(`${label}: maxCost must be above 0`);
  if (scope.maxTurns === 0) problems.push(`${label}: maxTurns must be at least 1`);
  for (const key of Object.keys(scope.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`${label}: env name ${JSON.stringify(key)} is not a valid variable name`);
    }
  }
  for (const rule of scope.subagents ?? []) {
    if (rule.agent.trim().length === 0) problems.push(`${label}: a subagent rule needs an agent`);
    for (const level of rule.thinking ?? []) {
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        problems.push(`${label}: subagent ${rule.agent} thinking ${level} is unknown`);
      }
    }
  }
}

export function stepProblems(step: Step, label: string): string[] {
  const problems: string[] = [];
  if (slug(step.name).length === 0) problems.push(`${label}: the step needs a name`);
  if (step.tasks.length === 0) problems.push(`${label}: the step needs at least one task`);
  checkScope(label, step.agent, problems);
  step.tasks.forEach((task, index) => {
    const taskLabel = `${label} task ${index + 1}`;
    if (task.prompt.trim().length === 0 && task.skill === undefined) {
      problems.push(`${taskLabel}: the task needs a prompt or a skill`);
    }
    for (const [field, value] of [
      ["delay", task.delay],
      ["every", task.every],
    ] as const) {
      if (value !== undefined && parseDuration(value) === null) {
        problems.push(`${taskLabel}: ${field} is not a duration such as 30s, 5m, or 1h30m`);
      }
    }
    if (task.repeat === 0) problems.push(`${taskLabel}: repeat must be at least 1`);
    if (task.skill !== undefined && task.skill.trim().length === 0) {
      problems.push(`${taskLabel}: the skill name is empty`);
    }
  });
  return problems;
}

/** Problems that stop the workflow from running; empty when it is valid. */
export function workflowProblems(workflow: Workflow): string[] {
  const problems: string[] = [];
  if (slug(workflow.name).length === 0) problems.push("the workflow needs a name");
  if (workflow.steps.length === 0 && (workflow.mode ?? "fixed") === "fixed") {
    problems.push("a fixed workflow needs at least one step");
  }
  checkScope("workflow agent", workflow.agent, problems);
  if (workflow.planner?.model !== undefined) checkModel("planner", workflow.planner.model, problems);
  const names: string[] = [];
  workflow.steps.forEach((step, index) => {
    const label = `step ${index + 1} (${step.name})`;
    problems.push(...stepProblems(step, label));
    const name = slug(step.name);
    if (name.length > 0 && names.includes(name)) problems.push(`${label}: another step has the same name`);
    names.push(name);
  });
  return problems;
}

/** The step's agent settings over the workflow defaults: set fields win and `env` entries merge. */
export function stepScope(workflow: Workflow, step: Step): Scope {
  const base = workflow.agent ?? {};
  const own = step.agent ?? {};
  const env = { ...(base.env ?? {}), ...(own.env ?? {}) };
  return clean({
    model: own.model ?? base.model,
    thinking: own.thinking ?? base.thinking,
    tools: own.tools ?? base.tools,
    skills: own.skills ?? base.skills,
    mcp: own.mcp ?? base.mcp,
    subagents: own.subagents ?? base.subagents,
    env: Object.keys(env).length ? env : undefined,
    systemPrompt: own.systemPrompt ?? base.systemPrompt,
    maxTurns: own.maxTurns ?? base.maxTurns,
    maxCost: own.maxCost ?? base.maxCost,
  });
}

/** Where the run dialog must ask for a model: the workflow default (`-1`) or a step index. */
export interface AskModel {
  target: number;
  label: string;
}

export function askModels(workflow: Workflow): AskModel[] {
  const out: AskModel[] = [];
  if (workflow.agent?.model === ASK) {
    out.push({ target: -1, label: `Default model for the steps of ${workflow.name}` });
  }
  workflow.steps.forEach((step, index) => {
    if (step.agent?.model === ASK) out.push({ target: index, label: `Model for step ${step.name}` });
  });
  return out;
}

/** Replaces each `ask` model with the chosen one; `null` inherits (removes the field). */
export function resolveAskModels(workflow: Workflow, choices: Record<string, string | null>): Workflow {
  const next = structuredClone(workflow);
  const pick = (scope: Scope | undefined, key: string): Scope | undefined => {
    if (scope?.model !== ASK) return scope;
    if (!(key in choices)) throw new Error(`choose a model for ${key === "-1" ? "the workflow" : `step ${Number(key) + 1}`}`);
    const choice = choices[key];
    const updated: Scope = { ...scope };
    if (choice === null || choice.trim().length === 0) delete updated.model;
    else updated.model = choice.trim();
    return updated;
  };
  next.agent = pick(next.agent, "-1");
  next.steps = next.steps.map((step, index) => ({ ...step, agent: pick(step.agent, String(index)) }));
  return normalizeWorkflow(next);
}

function clean<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}

function normalizeScope(scope: Scope | undefined): Scope | undefined {
  if (!scope) return undefined;
  // The field order of the extension's `Scope` struct.
  const out = clean({
    model: scope.model,
    thinking: scope.thinking,
    tools: scope.tools,
    skills: scope.skills,
    mcp: scope.mcp,
    subagents: scope.subagents?.map((rule) =>
      clean({
        agent: rule.agent,
        models: rule.models?.length ? rule.models : undefined,
        thinking: rule.thinking?.length ? rule.thinking : undefined,
      }),
    ),
    env: scope.env && Object.keys(scope.env).length ? scope.env : undefined,
    systemPrompt: scope.systemPrompt,
    maxTurns: scope.maxTurns,
    maxCost: scope.maxCost,
  });
  return Object.keys(out).length ? out : undefined;
}

/** The form the extension writes: default and empty fields left out, in the extension's field order. */
export function normalizeWorkflow(workflow: Workflow): Workflow {
  const planner = workflow.planner
    ? clean({
        instructions: workflow.planner.instructions?.length ? workflow.planner.instructions : undefined,
        model: workflow.planner.model,
        maxSteps: workflow.planner.maxSteps,
      })
    : undefined;
  return clean({
    name: workflow.name,
    description: workflow.description?.length ? workflow.description : undefined,
    mode: workflow.mode === "dynamic" ? "dynamic" : undefined,
    context: workflow.context && workflow.context !== "handoff" ? workflow.context : undefined,
    background: workflow.background ? true : undefined,
    agent: normalizeScope(workflow.agent),
    planner: planner && Object.keys(planner).length ? planner : undefined,
    steps: workflow.steps.map((step) =>
      clean({
        name: step.name,
        context: step.context,
        agent: normalizeScope(step.agent),
        tasks: step.tasks.map((task) =>
          clean({
            prompt: task.prompt,
            skill: task.skill,
            delay: task.delay,
            repeat: task.repeat,
            every: task.every,
            until: task.until,
            confirm: task.confirm ? true : undefined,
            optional: task.optional ? true : undefined,
          }),
        ),
      }),
    ),
  }) as Workflow;
}

export function emptyWorkflow(): Workflow {
  return {
    name: "",
    agent: { model: DEFAULT_MODEL, thinking: DEFAULT_THINKING },
    steps: [{ name: "step-1", tasks: [{ prompt: "" }] }],
  };
}

/** What a task does besides running once, for list rows: `wait 5m · 3 runs every 2m · approval`. */
export function describeTask(task: Task): string {
  const parts: string[] = [];
  if (task.delay) parts.push(`wait ${task.delay}`);
  if (task.until) parts.push(`until "${task.until}"`);
  const runs = task.repeat ?? (task.until ? 10 : 1);
  if (runs > 1) parts.push(task.every ? `${runs} runs every ${task.every}` : `${runs} runs`);
  else if (task.every && task.until) parts.push(`every ${task.every}`);
  if (task.confirm) parts.push("approval");
  if (task.optional) parts.push("optional");
  if (task.skill) parts.push(`/skill:${task.skill}`);
  return parts.join(" · ");
}
