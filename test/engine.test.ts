// The workflow store and the run engine against a temporary agent directory, a fake pi that
// answers the RPC catalog requests, and a fake runner that records how it was started.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pluginSettings } from "../shared/contracts";
import { parseWorkflowText, resolveAskModels, type Workflow } from "../shared/workflow";
import { applySettings } from "../server/pi";
import {
  approveRun,
  deleteRun,
  getRun,
  listRuns,
  releaseRuns,
  resumeRun,
  runOutput,
  runReport,
  setBackground,
  startRun,
  steerRun,
  stopRun,
} from "../server/runs";
import { deleteWorkflow, listWorkflows, loadCatalog, saveWorkflow } from "../server/workflows";
import { projectTrusted } from "../server/trust";

const root = mkdtempSync(path.join(tmpdir(), "pi-rust-plugin-"));
const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
const fakePi = path.join(root, "bin", "pi");
const fakeRunner = path.join(root, "bin", "pi-rust-ext");
const skillFile = path.join(root, "skills", "review", "SKILL.md");
const fixture = readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "ship-change.json"), "utf8");

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("0.12.10"); process.exit(0); }
if (args.includes("--list-models")) { console.log("provider model context max-out thinking images\\nanthropic claude-x 200K 64K yes no"); process.exit(0); }
if (args[0] === "--mode" && args[1] === "rpc") {
  fs.writeFileSync(${JSON.stringify(path.join(root, "probe-args.json"))}, JSON.stringify({ args, cwd: process.cwd(), run: process.env.PI_WORKFLOW_RUN }));
  console.log(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Trust?" }));
  // Like a startup dialog, the fake answers nothing until the dialog is cancelled.
  let buffer = "";
  let answeredDialog = false;
  const waiting = [];
  const answer = (msg) => {
    const reply = (data) => console.log(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }));
    if (msg.type === "get_commands") reply({ commands: [
      { name: "skill:review", source: "skill", sourceInfo: { path: ${JSON.stringify(skillFile)} } },
      { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } },
    ] });
    if (msg.type === "get_available_models") reply({ models: [{ provider: "anthropic", id: "claude-x" }] });
    if (msg.type === "get_state") reply({ model: { provider: "anthropic", id: "claude-x" }, thinkingLevel: "high" });
  };
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const msg = JSON.parse(line);
      if (msg.type === "extension_ui_response" && msg.id === "ui-1" && msg.cancelled === true) {
        answeredDialog = true;
        fs.writeFileSync(${JSON.stringify(path.join(root, "dialog.json"))}, JSON.stringify({ answeredDialog }));
        waiting.splice(0).forEach(answer);
        continue;
      }
      if (answeredDialog) answer(msg);
      else waiting.push(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  return;
}
process.exit(2);
`;

const FAKE_RUNNER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[process.argv.length - 1];
fs.writeFileSync(path.join(dir, "runner-args-" + Date.now() + ".json"), JSON.stringify(process.argv.slice(2)));
`;

function workflow(): Workflow {
  const parsed = parseWorkflowText(fixture);
  assert.ok(parsed.ok);
  return resolveAskModels(parsed.workflow, { "0": "openai/gpt-5" });
}

function runDir(id: string): string {
  return path.join(agentDir, "ext", "workflows", "runs", id);
}

function readRunJson(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(runDir(id), "run.json"), "utf8")) as Record<string, unknown>;
}

function writeRunJson(id: string, patch: Record<string, unknown>): void {
  writeFileSync(path.join(runDir(id), "run.json"), JSON.stringify({ ...readRunJson(id), ...patch }));
}

function queued(id: string, dir: "commands" | "inbox"): unknown[] {
  const folder = path.join(runDir(id), dir);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(folder, name), "utf8")) as unknown);
}

async function waitFor<T>(check: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

before(() => {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.dirname(skillFile), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(skillFile, "---\nname: review\n---\n");
  writeFileSync(fakePi, FAKE_PI);
  writeFileSync(fakeRunner, FAKE_RUNNER);
  chmodSync(fakePi, 0o755);
  chmodSync(fakeRunner, 0o755);
  writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { context7: {}, "my-db": {} } }));
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi, runnerPath: fakeRunner });
});

after(async () => {
  await releaseRuns();
});

test("workflows save, list, rename, hide, and delete", async () => {
  const saved = await saveWorkflow(JSON.parse(fixture), "global", project);
  assert.equal(saved.path, path.join(agentDir, "ext", "workflows", "definitions", "ship-change.json"));
  assert.equal(readFileSync(saved.path, "utf8"), fixture);
  await assert.rejects(saveWorkflow(JSON.parse(fixture), "global", project), /exists already/);

  const renamed = { ...JSON.parse(fixture), name: "Ship It" };
  await saveWorkflow(renamed, "global", project, { previous: { name: "ship-change", scope: "global" } });
  let listed = await listWorkflows({ cwd: project });
  assert.deepEqual(listed.workflows.map((w) => `${w.source}:${w.name}`), ["global:ship-it"]);
  assert.deepEqual(listed.workflows[0].inputs, ["change", "base_branch"]);
  assert.equal(listed.trusted, true);

  await saveWorkflow({ ...renamed, description: "project copy" }, "project", project);
  writeFileSync(path.join(project, ".pi", "ext", "workflows", "definitions", "broken.json"), "{ nope");
  listed = await listWorkflows({ cwd: project });
  assert.deepEqual(listed.workflows.map((w) => `${w.source}:${w.name}:${w.description}`), ["project:ship-it:project copy"]);
  assert.equal(listed.errors.length, 1);
  assert.match(listed.errors[0], /broken\.json/);

  await assert.rejects(saveWorkflow({ name: "bad", steps: [] }, "global", project), /a fixed workflow needs at least one step/);
  await deleteWorkflow({ name: "ship-it", scope: "project", cwd: project });
  await deleteWorkflow({ name: "ship-it", scope: "global", cwd: project });
  listed = await listWorkflows({ cwd: project });
  assert.equal(listed.workflows.length, 0);
});

test("an untrusted project refuses project workflows", async () => {
  const untrusted = path.join(root, "untrusted");
  mkdirSync(path.join(untrusted, ".pi"), { recursive: true });
  writeFileSync(path.join(untrusted, ".pi", "settings.json"), "{}");
  assert.equal(projectTrusted(untrusted), false);
  await assert.rejects(saveWorkflow(JSON.parse(fixture), "project", untrusted), /not trusted/);
  writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify({ [untrusted]: true }));
  assert.equal(projectTrusted(untrusted), true);
});

test("the catalog comes from pi's RPC mode, quietly", async () => {
  const catalog = await loadCatalog(project, true);
  assert.deepEqual(catalog.skills, { review: skillFile });
  assert.deepEqual(catalog.mcpServers, ["context7", "my-db"]);
  assert.deepEqual(catalog.models, ["anthropic/claude-x"]);
  assert.equal(catalog.parentModel, "anthropic/claude-x");
  assert.equal(catalog.parentThinking, "high");
  const probe = JSON.parse(readFileSync(path.join(root, "probe-args.json"), "utf8")) as { args: string[]; cwd: string; run: string };
  assert.equal(probe.run, "paseo-catalog");
  assert.ok(probe.args.includes("--no-session"));
  assert.equal(JSON.parse(readFileSync(path.join(root, "dialog.json"), "utf8")).answeredDialog, true);
});

test("a run starts a detached runner with the state pi writes", async () => {
  await assert.rejects(startRun({ workflow: workflow(), cwd: project, inputs: { change: "x" }, background: true, origin: "user", agentId: null }), /missing inputs: base_branch/);
  const unknownSkill = workflow();
  unknownSkill.steps[0].tasks[0].skill = "nope";
  await assert.rejects(startRun({ workflow: unknownSkill, cwd: project, inputs: { change: "x", base_branch: "main" }, background: true, origin: "user", agentId: null }), /unknown skills: nope/);

  const id = await startRun({ workflow: workflow(), cwd: project, inputs: { change: " fix it ", base_branch: "main" }, background: false, origin: "agent", agentId: "agent-1" });
  assert.match(id, /^wf-[0-9a-z]+$/);
  const state = readRunJson(id);
  assert.equal(state.status, "running");
  assert.equal(state.owner, process.pid);
  assert.equal(state.background, false);
  assert.equal(state.origin, "agent");
  assert.equal(state.cwd, project);
  assert.equal(state.pi, fakePi);
  assert.equal(state.parentModel, "anthropic/claude-x");
  assert.deepEqual(state.inputs, { change: "fix it", base_branch: "main" });
  assert.deepEqual(state.catalog, { skills: { review: skillFile }, mcpServers: ["context7", "my-db"] });
  assert.equal((state.steps as unknown[]).length, 3);
  assert.equal((state.workflow as Workflow).steps[0].agent?.model, "openai/gpt-5");
  for (const file of ["report.schema.json", "plan.schema.json", "memory.md", "paseo.json", "runner.log"]) {
    assert.ok(existsSync(path.join(runDir(id), file)), file);
  }
  await waitFor(() => existsSync(path.join(agentDir, "ext", "workflows", "sessions", String(process.pid))));
  const args = await waitFor(() => readdirSync(runDir(id)).find((name) => name.startsWith("runner-args-")));
  assert.deepEqual(JSON.parse(readFileSync(path.join(runDir(id), args), "utf8")), ["workflows", "--runner", runDir(id)]);

  const { runs } = await listRuns({ cwd: project });
  assert.equal(runs[0].id, id);
  assert.equal(runs[0].ownedHere, true);
  assert.equal(runs[0].paseoAgentId, "agent-1");
  assert.equal(runs[0].currentStep, 0);
});

test("run control writes the runner's command files", async () => {
  const { runs } = await listRuns({ cwd: project });
  const id = runs[0].id;
  await assert.rejects(approveRun(id, "run"), /does not wait for an approval/);
  await assert.rejects(steerRun(id, "hi"), /No agent of run/);
  writeRunJson(id, {
    approval: { task: "Merge the PR.", step: 1, askedMs: Date.now() },
    steps: [{ status: "running", tasksDone: 0, runs: 1, activity: "bash: gh pr checks", writing: "", log: [] }, {}, {}],
    waitUntilMs: Date.now() + 60_000,
    heartbeatMs: Date.now(),
  });
  assert.equal(await approveRun(id, "skip"), 'Skipped "Merge the PR." of ship-change.');
  await steerRun(id, "  use the staging branch ");
  await setBackground(id, true);
  await stopRun(id);
  assert.deepEqual(queued(id, "commands"), [
    { type: "approve", decision: "skip" },
    { type: "mode", background: true, owner: process.pid },
    { type: "stop" },
  ]);
  assert.deepEqual(queued(id, "inbox"), ["use the staging branch"]);
  const { run } = await getRun({ id });
  assert.equal(run.agentStep, 0);
  assert.equal(run.activity, "bash: gh pr checks");
  await assert.rejects(deleteRun(id), /still active/);

  mkdirSync(path.join(runDir(id), "output"), { recursive: true });
  writeFileSync(
    path.join(runDir(id), "output", "01.jsonl"),
    `${JSON.stringify({ kind: "prompt", text: "Implement" })}\n${JSON.stringify({ kind: "assistant", text: "Done" })}\n{"kind":"to`,
  );
  assert.deepEqual(await runOutput({ id, step: 0 }), { entries: [{ kind: "prompt", text: "Implement" }, { kind: "assistant", text: "Done" }], total: 2 });
});

test("stale, failed, and done runs resume or refuse as pi does", async () => {
  const { runs } = await listRuns({ cwd: project });
  const id = runs[0].id;
  writeRunJson(id, { heartbeatMs: Date.now() - 60_000 });
  assert.equal((await getRun({ id })).run.stale, true);

  writeRunJson(id, {
    status: "failed",
    error: "blocked",
    endedMs: Date.now(),
    steps: [{ status: "done", summary: "implemented", cost: 1.5 }, { status: "failed", activity: "x" }, { status: "pending" }],
  });
  const failed = (await getRun({ id })).run;
  assert.match(runReport(failed), /ship-change \(wf-[0-9a-z]+\) failed after .* · \$1\.50\.\nError: blocked\n1\. implement: done · \$1\.50\n   implemented/);
  await resumeRun(id);
  const resumed = readRunJson(id) as { status: string; error: unknown; endedMs: unknown; steps: { status: string; activity?: string }[] };
  assert.equal(resumed.status, "running");
  assert.equal(resumed.error, null);
  assert.equal(resumed.endedMs, null);
  assert.deepEqual(resumed.steps.map((step) => step.status), ["done", "pending", "pending"]);
  assert.equal(resumed.steps[1].activity, undefined);
  await waitFor(() => readdirSync(runDir(id)).filter((name) => name.startsWith("runner-args-")).length === 2);

  await assert.rejects(resumeRun(id), /is still running/);
  writeRunJson(id, { status: "done", endedMs: Date.now() });
  await assert.rejects(resumeRun(id), /is done/);
  await deleteRun(id);
  assert.equal(existsSync(runDir(id)), false);
});
