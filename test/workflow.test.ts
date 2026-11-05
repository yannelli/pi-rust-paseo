import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  askModels,
  describeTask,
  emptyWorkflow,
  formatDuration,
  normalizeWorkflow,
  parseDuration,
  parseWorkflow,
  parseWorkflowText,
  placeholders,
  resolveAskModels,
  slug,
  stepScope,
  workflowInputs,
  workflowProblems,
  type Workflow,
} from "../shared/workflow";

const fixture = readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "ship-change.json"), "utf8");

function load(): Workflow {
  const parsed = parseWorkflowText(fixture);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.workflow;
}

test("slug keeps letters, digits, and single dashes", () => {
  assert.equal(slug("  Ship Change!! v2 "), "ship-change-v2");
  assert.equal(slug("a__b"), "a__b");
  assert.equal(slug("--x--"), "x");
  assert.equal(slug("!!!"), "");
});

test("durations parse like the extension", () => {
  assert.equal(parseDuration("30s"), 30);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("2d"), 172_800);
  assert.equal(parseDuration("45"), 45);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("5x"), null);
  assert.equal(parseDuration("m"), null);
  assert.equal(parseDuration("5m3"), null);
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(61), "1m1s");
});

test("placeholders and inputs follow first use; dynamic adds goal", () => {
  assert.deepEqual(placeholders("{{ a }} {{b-c}} {{bad name}} {{a}} {{"), ["a", "b-c", "a"]);
  const workflow = load();
  assert.deepEqual(workflowInputs(workflow), ["change", "base_branch"]);
  assert.deepEqual(workflowInputs({ ...workflow, mode: "dynamic" }), ["goal", "change", "base_branch"]);
});

test("the fixture is valid and round-trips through normalize unchanged", () => {
  const workflow = load();
  assert.deepEqual(workflowProblems(workflow), []);
  assert.equal(`${JSON.stringify(normalizeWorkflow(workflow), null, 2)}\n`, fixture);
});

test("unknown fields are errors, as serde deny_unknown_fields", () => {
  const parsed = parseWorkflow({ name: "x", steps: [{ name: "a", tasks: [{ prompt: "p", promt: "typo" }] }] });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /steps\.0\.tasks\.0/);
});

test("problems use the extension's wording", () => {
  const workflow: Workflow = {
    name: "",
    agent: { model: "gpt", thinking: "huge", maxCost: 0, maxTurns: 0, env: { "1BAD": "x" }, subagents: [{ agent: " ", thinking: ["lots"] }] },
    planner: { model: "nope" },
    steps: [
      { name: "a", tasks: [] },
      { name: "A", tasks: [{ prompt: " ", delay: "soon", every: "5x", repeat: 0, skill: " " }] },
    ],
  };
  assert.deepEqual(workflowProblems(workflow), [
    "the workflow needs a name",
    'workflow agent: model "gpt" must be provider/id or "ask"',
    "workflow agent: thinking must be one of off, minimal, low, medium, high, xhigh, max",
    "workflow agent: maxCost must be above 0",
    "workflow agent: maxTurns must be at least 1",
    'workflow agent: env name "1BAD" is not a valid variable name',
    "workflow agent: a subagent rule needs an agent",
    "workflow agent: subagent   thinking lots is unknown",
    'planner: model "nope" must be provider/id or "ask"',
    "step 1 (a): the step needs at least one task",
    "step 2 (A) task 1: delay is not a duration such as 30s, 5m, or 1h30m",
    "step 2 (A) task 1: every is not a duration such as 30s, 5m, or 1h30m",
    "step 2 (A) task 1: repeat must be at least 1",
    "step 2 (A) task 1: the skill name is empty",
    "step 2 (A): another step has the same name",
  ]);
  assert.deepEqual(workflowProblems({ name: "x", mode: "dynamic", steps: [] }), []);
  assert.deepEqual(workflowProblems({ name: "x", steps: [] }), ["a fixed workflow needs at least one step"]);
});

test("ask models resolve to a choice or inherit", () => {
  const workflow = load();
  assert.deepEqual(askModels(workflow), [{ target: 0, label: "Model for step implement" }]);
  assert.throws(() => resolveAskModels(workflow, {}), /choose a model for step 1/);
  const chosen = resolveAskModels(workflow, { "0": "openai/gpt-5" });
  assert.equal(chosen.steps[0].agent?.model, "openai/gpt-5");
  const inherited = resolveAskModels(workflow, { "0": null });
  assert.equal(inherited.steps[0].agent?.model, undefined);
  assert.equal(inherited.steps[0].agent?.thinking, "high");
});

test("step scope merges over the workflow agent", () => {
  const workflow = load();
  const scope = stepScope(workflow, workflow.steps[2]);
  assert.equal(scope.model, "anthropic/claude-haiku-5-5");
  assert.equal(scope.thinking, "low");
  const ship = stepScope(workflow, workflow.steps[1]);
  assert.equal(ship.model, "anthropic/claude-opus-5-5");
  assert.deepEqual(ship.env, { DATABASE_URL: "${STAGING_DATABASE_URL}" });
});

test("task descriptions name waits, loops, and approvals", () => {
  const workflow = load();
  assert.equal(describeTask(workflow.steps[1].tasks[0]), 'wait 90s · until "All CI checks pass" · 15 runs every 2m');
  assert.equal(describeTask(workflow.steps[1].tasks[1]), "approval");
  assert.equal(describeTask(workflow.steps[2].tasks[0]), "wait 5m · 3 runs every 5m · optional");
});

test("new workflows start with the default model and thinking", () => {
  const workflow = emptyWorkflow();
  assert.deepEqual(workflow.agent, { model: "anthropic/claude-opus-5-5", thinking: "medium" });
  assert.deepEqual(workflowProblems({ ...workflow, name: "x", steps: [{ name: "a", tasks: [{ prompt: "go" }] }] }), []);
});
