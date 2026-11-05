// Demo data for the screenshots: a made-up developer, "Ada", with an acme-api repository, two
// worktrees, and a web app. Everything lives under a temporary root; the server shows the paths
// without that root, so the screenshots read /Users/ada/... . No data from the machine that
// renders them appears in the images.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = "/Users/ada";
export const MAIN = `${HOME}/code/acme-api`;
export const WORKTREE = `${HOME}/.paseo/worktrees/k3x9/brave-otter`;
export const WORKTREE2 = `${HOME}/.paseo/worktrees/m2p7/calm-heron`;
export const WEB = `${HOME}/code/web-app`;
export const SESSION = "01a1c0de-4d61-7a00-9e11-7a5c00ffee01";
export const AGENT_ID = "agent-ada";

const MINUTE = 60_000;

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" } });
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const shipChange = {
  name: "ship-change",
  description: "Implement a change, check it against current docs, open a PR, wait for CI, and merge after approval.",
  context: "memory",
  background: true,
  agent: { model: "anthropic/claude-opus-5-5", thinking: "medium" },
  steps: [
    { name: "implement", agent: { thinking: "high" }, tasks: [{ prompt: "Implement this change: {{change}}. Follow the conventions of the code around it." }] },
    { name: "docs-check", agent: { model: "openai/gpt-6.1-terra", thinking: "high", mcp: ["context7"] }, tasks: [{ prompt: "Check every library the change uses against its current docs and fix outdated calls." }] },
    {
      name: "ci",
      tasks: [
        { prompt: "Open a PR against {{base_branch}} and wait for CI. Fix failures.", delay: "90s", repeat: 15, every: "2m", until: "All checks pass" },
        { prompt: "Merge the PR into {{base_branch}}.", confirm: true },
      ],
    },
    { name: "monitor", agent: { model: "anthropic/claude-haiku-5-5", thinking: "low", tools: ["bash", "read"] }, tasks: [{ prompt: "Watch the production logs for new errors.", delay: "5m", repeat: 3, every: "5m", optional: true }] },
  ],
};

const nightlyDeps = {
  name: "nightly-deps",
  description: "Update dependencies, run the test suite, and open one PR with the results.",
  agent: { model: "anthropic/claude-opus-5-5", thinking: "medium" },
  steps: [
    { name: "bump", tasks: [{ prompt: "Update the dependencies that have patch and minor releases." }] },
    { name: "verify", agent: { model: "openai/gpt-6.1-terra", thinking: "high" }, tasks: [{ prompt: "Run the type check, lint, and tests. Fix what the updates broke." }] },
    { name: "pr", tasks: [{ prompt: "Open a PR that lists each update and anything you fixed." }] },
  ],
};

const docsAudit = {
  name: "docs-audit",
  description: "Plan and run a documentation audit toward a goal; a planner writes the steps as it learns.",
  mode: "dynamic",
  agent: { model: "anthropic/claude-opus-5-5", thinking: "medium" },
  planner: { instructions: "Keep each step small enough for one session.", maxSteps: 6 },
  steps: [],
};

const releaseNotes = {
  name: "release-notes",
  description: "Draft release notes from the merged PRs since the last tag.",
  agent: { model: "anthropic/claude-opus-5-5", thinking: "medium" },
  steps: [{ name: "draft", tasks: [{ prompt: "Write release notes for the PRs merged since {{since_tag}}." }] }],
};

const rateLimitCheck = {
  name: "rate-limit-check",
  description: "Load-test the new limits against staging and report the 429 rates.",
  agent: { model: "anthropic/claude-opus-5-5", thinking: "medium", env: { API_URL: "${STAGING_API_URL}" } },
  steps: [{ name: "load-test", tasks: [{ prompt: "Run the k6 script against staging and summarize the 429s per key." }] }],
};

function step(fields) {
  return { status: "pending", tasksDone: 0, runs: 0, startedMs: null, endedMs: null, summary: "", cost: 0, turns: 0, model: null, log: [], ...fields };
}

function done(now, startMin, endMin, cost, turns, model, summary, tasks = 1) {
  return step({ status: "done", tasksDone: tasks, runs: 1, startedMs: now - startMin * MINUTE, endedMs: now - endMin * MINUTE, cost, turns, model, summary, log: [`run 1: done after ${turns} turns`] });
}

function run(runsDir, state, extras = {}) {
  const dir = path.join(runsDir, state.id);
  write(path.join(dir, "run.json"), {
    inputs: {},
    origin: "user",
    endedMs: null,
    waitUntilMs: null,
    note: "",
    error: null,
    parentModel: "anthropic/claude-opus-5-5",
    parentThinking: "medium",
    background: true,
    owner: 4242,
    heartbeatMs: Date.now(),
    approval: null,
    pi: `${HOME}/.local/bin/pi`,
    catalog: { skills: {}, mcpServers: ["context7", "github"] },
    ...state,
  });
  write(path.join(dir, "memory.md"), "## implement\n- Added `RateLimiter` middleware in `src/http/limits.ts` (token bucket, per API key).\n- Uses `express-rate-limit@7.4.0` with the Redis store.\n\n## docs-check\n- v7 renamed `max` to `limit`; fixed in `limits.ts`.\n");
  for (const [n, entries] of Object.entries(extras.output ?? {})) {
    write(path.join(dir, "output", `${String(n).padStart(2, "0")}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  }
  if (extras.link) write(path.join(dir, "paseo.json"), extras.link);
}

/** Builds the demo under a new temporary root and returns how to reach it. */
export function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rust-paseo-demo-"));
  const real = (fake) => path.join(root, fake);
  const agentDir = real(`${HOME}/.pi/agent`);
  const now = Date.now();

  // Repositories: acme-api with two linked worktrees, and web-app.
  fs.mkdirSync(real(MAIN), { recursive: true });
  git(real(MAIN), "init", "-q", "-b", "main");
  write(real(`${MAIN}/README.md`), "# acme-api\n");
  git(real(MAIN), "add", ".");
  git(real(MAIN), "commit", "-q", "-m", "init");
  git(real(MAIN), "remote", "add", "origin", "git@github.com:acme/acme-api.git");
  fs.mkdirSync(path.dirname(real(WORKTREE)), { recursive: true });
  fs.mkdirSync(path.dirname(real(WORKTREE2)), { recursive: true });
  git(real(MAIN), "worktree", "add", "-q", "-b", "feat/rate-limits", real(WORKTREE));
  git(real(MAIN), "worktree", "add", "-q", "-b", "fix/auth-timeout", real(WORKTREE2));
  write(real(`${WORKTREE}/src/http/limits.ts`), "export const limit = 100;\n");
  write(real(`${WORKTREE}/README.md`), "# acme-api\n\nRate limits.\n");
  fs.mkdirSync(real(WEB), { recursive: true });
  git(real(WEB), "init", "-q", "-b", "main");

  // pi settings with deferred rules, as /deferred set writes them.
  write(path.join(agentDir, "settings.json"), {
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-5-5",
    skills: ["-skills/release-notes/SKILL.md"],
    deferred: {
      tools: {
        "mcp__*": "names",
        "mcp__github__*": "deferred",
        "mcp__playwright__*": "deferred",
        web_fetch: "off",
        bg_run: "names",
        bg_status: "names",
        bg_logs: "names",
        bg_kill: "names",
        todo: "names",
        subagent: "names",
        read: "on",
        bash: "on",
      },
      skills: { "*": "names", commit: "on", "release-*": "user" },
      context: { "docs/AGENTS.md": "deferred" },
      sections: { mcp_servers: "names" },
      repos: { "acme/acme-api": { tools: { "mcp__github__delete_repo": "off" }, skills: { "deploy-prod": "user" } } },
      auto: 10,
      maxResults: 5,
    },
  });

  // Prompt files and context: a global addendum, global and project AGENTS.md with includes.
  write(path.join(agentDir, "APPEND_SYSTEM.md"), "## House rules\n\n- Prefer small, reviewed changes.\n- Run the tests before you say a change works.\n");
  write(path.join(agentDir, "AGENTS.md"), "# Ada's defaults\n\n- Write commit messages in the imperative.\n- Ask before adding a dependency.\n");
  for (const dir of [MAIN, WORKTREE]) {
    write(real(`${dir}/AGENTS.md`), "# acme-api\n\nTypeScript service on Express and Postgres.\n\n@docs/architecture.md\n@docs/runbooks/deploy.md\n\n## Testing\n\n- `pnpm test` runs the unit tests.\n");
    write(real(`${dir}/docs/architecture.md`), "# Architecture\n\nRequests pass auth, rate limits, then the route handlers.\n");
  }

  // Skills and prompt templates: pi's own, the shared ~/.agents folder, and the worktree's, which Ada trusts.
  write(path.join(agentDir, "trust.json"), { [fs.realpathSync(real(WORKTREE))]: true });
  const skill = (dir, name, description, extra = "") => write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSteps go here.\n`);
  skill(path.join(agentDir, "skills"), "commit", "Writes a commit message from the staged diff. Use when asked to commit.");
  skill(path.join(agentDir, "skills"), "release-notes", "Drafts release notes from merged pull requests since the last tag.");
  skill(path.join(agentDir, "skills"), "deploy-prod", "Deploys the main branch to production after checks pass.", "disable-model-invocation: true\n");
  skill(real(`${HOME}/.agents/skills`), "design-review", "Reviews a UI change for spacing, contrast, and states. Use for frontend pull requests.");
  skill(real(`${HOME}/.agents/skills`), "sql-tuning", "Finds slow queries in EXPLAIN output and suggests indexes.");
  skill(real(`${WORKTREE}/.pi/skills`), "rate-limit-audit", "Checks every public route for a rate limit and a test of it.");
  write(path.join(agentDir, "prompts", "review.md"), "---\ndescription: Review the staged changes\nargument-hint: \"[focus]\"\n---\n\nReview the staged changes. Focus on $ARGUMENTS.\n");
  write(path.join(agentDir, "prompts", "standup.md"), "---\ndescription: Summarize yesterday's commits for standup\n---\n\nSummarize my commits since yesterday morning.\n");

  // Claude plugins: two marketplaces, three installed plugins (one off), two available.
  const claude = path.join(agentDir, "ext", "claude-marketplace");
  const marketplaces = [
    {
      name: "community-plugins",
      source: "acme-oss/claude-plugins",
      gitUrl: "https://github.com/acme-oss/claude-plugins.git",
      description: "Plugins the Acme team maintains for Claude Code.",
      plugins: [
        { name: "commit-helper", description: "Commit, push, and open a pull request in one step.", version: "1.4.0", category: "git", installed: true, skills: ["commit-helper-conventional"], commands: ["commit-helper:commit", "commit-helper:commit-push-pr"] },
        { name: "pr-review", description: "Reviewers for tests, types, comments, and silent failures.", version: "2.1.0", category: "review", installed: true, agents: ["pr-review-test-analyzer", "pr-review-type-checker"], commands: ["pr-review:review"] },
        { name: "security-hooks", description: "Warns before edits that add injection, unsafe deserialization, or secrets.", version: "0.9.2", category: "security" },
        { name: "frontend-design", description: "Distinctive, production-grade interfaces with real typography and spacing.", version: "1.0.0", category: "design", remote: true },
      ],
    },
    {
      name: "acme-internal",
      source: `${HOME}/code/acme-plugins`,
      gitUrl: null,
      description: "Internal deploy and on-call tools.",
      plugins: [{ name: "deploy-tools", description: "Deploy, roll back, and check service health.", version: "0.3.0", installed: true, enabled: false, mcp: ["plugin_deploy-tools_status"] }],
    },
  ];
  const state = { marketplaces: {}, plugins: {} };
  const config = { marketplaces: {}, plugins: {} };
  for (const market of marketplaces) {
    const rootDir = market.gitUrl ? path.join(claude, "sources", market.name) : real(market.source);
    write(path.join(rootDir, ".claude-plugin", "marketplace.json"), {
      name: market.name,
      description: market.description,
      owner: { name: "Acme" },
      plugins: market.plugins.map((plugin) => ({
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        category: plugin.category,
        source: plugin.remote ? { source: "github", repo: `acme-oss/${plugin.name}` } : `./plugins/${plugin.name}`,
      })),
    });
    state.marketplaces[market.name] = { name: market.name, source: market.gitUrl ? market.source : rootDir, gitUrl: market.gitUrl, root: rootDir, manifest: path.join(rootDir, ".claude-plugin", "marketplace.json") };
    config.marketplaces[market.name] = { source: market.source, autoUpdate: market.name === "community-plugins" };
    for (const plugin of market.plugins.filter((entry) => entry.installed)) {
      const id = `${plugin.name}@${market.name}`;
      const enabled = plugin.enabled !== false;
      const files = [];
      for (const name of plugin.skills ?? []) {
        const dir = path.join(claude, "resources", "skills", name);
        write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Conventional Commits messages for the staged changes.\n---\n\nSteps.\n`);
        files.push(dir);
      }
      for (const name of plugin.commands ?? []) {
        const file = path.join(claude, "resources", "prompts", `${name}.md`);
        write(file, `---\ndescription: ${name.split(":").pop().replace(/-/g, " ")}\n---\n\nDo it.\n`);
        files.push(file);
      }
      for (const name of plugin.agents ?? []) files.push(path.join(agentDir, "ext", "subagents", "agents", `${name}.md`));
      state.plugins[id] = {
        plugin: plugin.name,
        marketplace: market.name,
        marketplaceScope: "user",
        version: plugin.version,
        description: plugin.description,
        enabled,
        pluginRoot: path.join(rootDir, "plugins", plugin.name),
        files: enabled ? files : [],
        hooks: false,
        mcpKeys: enabled ? (plugin.mcp ?? []) : plugin.mcp ?? [],
        unsupported: plugin.name === "pr-review" ? ["outputStyles"] : [],
      };
      config.plugins[id] = { enabled };
    }
  }
  write(path.join(claude, "state.json"), state);
  write(path.join(agentDir, "ext", "claude-marketplace.json"), config);

  // Workflows: three global, one in the main checkout (not committed), one in the worktree.
  const definitions = path.join(agentDir, "ext", "workflows", "definitions");
  for (const workflow of [shipChange, nightlyDeps, docsAudit]) write(path.join(definitions, `${workflow.name}.json`), workflow);
  write(real(`${MAIN}/.pi/ext/workflows/definitions/release-notes.json`), releaseNotes);
  write(real(`${WORKTREE}/.pi/ext/workflows/definitions/rate-limit-check.json`), rateLimitCheck);

  // Runs.
  const runsDir = path.join(agentDir, "ext", "workflows", "runs");
  run(
    runsDir,
    {
      id: "wf-mw4demo1",
      workflow: shipChange,
      cwd: real(WORKTREE),
      status: "running",
      startedMs: now - 18 * MINUTE,
      inputs: { change: "Rate limit the public API per key", base_branch: "main" },
      steps: [
        done(now, 18, 7, 2.41, 38, "anthropic/claude-opus-5-5", "Added a token-bucket limiter to the public routes with per-key limits and Redis storage. Unit tests pass."),
        step({ status: "running", runs: 1, startedMs: now - 6 * MINUTE, cost: 0.38, turns: 9, model: "openai/gpt-6.1-terra", activity: "web_search express-rate-limit v7 migration guide", writing: "The change uses `express-rate-limit@7.4.0`. Version 7 renamed `max` to `limit`, so" }),
        step({}),
        step({}),
      ],
    },
    {
      output: {
        2: [
          { kind: "prompt", text: '# Workflow ship-change: step 2 of 4, "docs-check"\n\nCheck every library the change uses against its current docs and fix outdated calls.' },
          { kind: "assistant", text: "I'll read the diff first, then check each library against its current docs." },
          { kind: "tool", text: "bash git diff --stat main" },
          { kind: "tool", text: "read src/http/limits.ts" },
          { kind: "user", text: "Also check the Redis store adapter." },
          { kind: "tool", text: "mcp__context7__get-library-docs express-rate-limit" },
          { kind: "assistant", text: "The limiter options match **v7** except for one renamed option, and the Redis store needs `sendCommand` instead of `client`." },
        ],
      },
    },
  );
  run(
    runsDir,
    {
      id: "wf-mw4demo2",
      workflow: shipChange,
      cwd: real(WORKTREE2),
      status: "running",
      startedMs: now - 42 * MINUTE,
      inputs: { change: "Raise the auth token timeout to 30 minutes", base_branch: "main" },
      approval: { task: "Merge the PR into main.", step: 2, askedMs: now - 3 * MINUTE },
      note: 'Waits for approval of "Merge the PR into main."',
      steps: [
        done(now, 42, 31, 1.92, 27, "anthropic/claude-opus-5-5", "Raised the timeout and updated the session tests."),
        done(now, 31, 24, 0.44, 11, "openai/gpt-6.1-terra", "The docs match; nothing to change."),
        step({ status: "running", tasksDone: 1, runs: 6, startedMs: now - 22 * MINUTE, cost: 0.71, turns: 19, model: "anthropic/claude-opus-5-5", summary: "PR #214 is green.", log: ["run 1: continue: 4 checks pending", "run 6: done: all checks pass"] }),
        step({}),
      ],
    },
    { link: { agentId: AGENT_ID, origin: "agent" } },
  );
  run(runsDir, {
    id: "wf-mw4demo3",
    workflow: nightlyDeps,
    cwd: real(MAIN),
    status: "waiting",
    startedMs: now - 9 * MINUTE,
    waitUntilMs: now + 4 * MINUTE + 12_000,
    note: "Next check in 4m",
    steps: [done(now, 9, 6, 0.8, 14, "anthropic/claude-opus-5-5", "Updated 6 packages."), step({ status: "running", runs: 2, startedMs: now - 5 * MINUTE, cost: 0.12, turns: 4, model: "openai/gpt-6.1-terra", log: ["run 1: continue: 3 checks pending"] }), step({})],
  });
  run(runsDir, {
    id: "wf-mw4demo4",
    workflow: { ...nightlyDeps, name: "docs-sync" },
    cwd: real(WEB),
    status: "failed",
    startedMs: now - 3 * 60 * MINUTE,
    endedMs: now - 3 * 60 * MINUTE + 11 * MINUTE,
    error: "step 2 (verify): the agent reported blocked: the staging database is not reachable",
    steps: [done(now, 180, 175, 1.2, 20, "anthropic/claude-opus-5-5", "Collected the changed APIs."), step({ status: "failed", runs: 1, startedMs: now - 175 * MINUTE, endedMs: now - 169 * MINUTE, cost: 0.05, turns: 2, model: "openai/gpt-6.1-terra", summary: "blocked: the staging database is not reachable", log: ["run 1: blocked"] }), step({})],
  });
  run(runsDir, {
    id: "wf-mw4demo5",
    workflow: shipChange,
    cwd: real(MAIN),
    status: "done",
    startedMs: now - 26 * 60 * MINUTE,
    endedMs: now - 25 * 60 * MINUTE,
    steps: [
      done(now, 1560, 1540, 3.1, 44, "anthropic/claude-opus-5-5", "Added request IDs to every log line."),
      done(now, 1540, 1530, 0.6, 12, "openai/gpt-6.1-terra", "The logging calls match pino 9."),
      done(now, 1530, 1505, 1.1, 21, "anthropic/claude-opus-5-5", "PR #209 merged into main.", 2),
      done(now, 1505, 1500, 0.2, 6, "anthropic/claude-haiku-5-5", "No new errors in three checks."),
    ],
  });

  // Background tasks, a timer, and a goal of Ada's pi session in the worktree.
  const sleeper = spawn("sleep", ["900"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  const tasks = path.join(agentDir, "ext", "background-tasks", "sessions", SESSION);
  const task = (id, fields, output = "") => {
    write(path.join(tasks, id, "task.json"), { id, cwd: real(WORKTREE), isAgent: false, ...fields });
    write(path.join(tasks, id, "output.log"), output);
  };
  const lstart = () => execFileSync("ps", ["-o", "lstart=", "-p", String(sleeper.pid)], { env: { ...process.env, LC_ALL: "C" }, encoding: "utf8" }).trim().split(/\s+/).join(" ");
  task(
    "a1b2c3d4",
    { name: "E2E suite", description: "Desktop and mobile Playwright suite", command: "npm run test:e2e -- --workers=4", pid: sleeper.pid, processStart: lstart(), status: "running", startedAt: now - 4 * MINUTE, timeoutSeconds: 900 },
    "Running 148 tests using 4 workers\n\n  ✓  1 [desktop] › limits.spec.ts:12 › returns 429 after the limit (1.2s)\n  ✓  2 [desktop] › limits.spec.ts:31 › resets after the window (0.9s)\n  ✓  3 [mobile] › auth.spec.ts:8 › signs in (1.4s)\n  ·  4 [mobile] › limits.spec.ts:44 › separate keys\n",
  );
  task("e5f6a7b8", { name: "Type check", description: "tsc --noEmit for the workspace", command: "npx tsc --noEmit", status: "completed", exitCode: 0, startedAt: now - 9 * MINUTE, endedAt: now - 8 * MINUTE });
  task("c9d0e1f2", { name: "Lint", description: "Biome check of the changed files", command: "npx biome check src", status: "failed", exitCode: 1, startedAt: now - 7 * MINUTE, endedAt: now - 6 * MINUTE }, "src/http/limits.ts:14:7 lint/style/useConst  This let is only assigned once.\nFound 1 error.\n");
  write(path.join(agentDir, "ext", "timers", "sessions", `${SESSION}.json`), {
    heartbeats: [{ id: "hb1", name: "CI watch", reason: "check the PR checks", everySecs: 600, pulses: 3, maxPulses: 12, nextAt: now + 7 * MINUTE }],
    schedules: [],
  });
  const slug = [...WORKTREE].map((c) => (/[A-Za-z0-9]/.test(c) ? c : "-")).join("").replace(/^-+|-+$/g, "");
  write(path.join(agentDir, "ext", "goal", "projects", slug, "g1.json"), {
    id: "g1",
    objective: "Objective: Rate limit the public API per key, with tests and docs",
    status: "active",
    tasks: [
      { id: "t1", title: "Design the limits", status: "complete" },
      { id: "t2", title: "Implement the middleware", status: "complete" },
      { id: "t3", title: "Write integration tests", status: "in_progress" },
      { id: "t4", title: "Document the limits", status: "pending" },
    ],
    currentTaskId: "t3",
    updatedAt: now,
  });

  const agent = { id: AGENT_ID, provider: "pi", cwd: real(WORKTREE), workspaceId: "wks-acme-rate", persistence: { provider: "pi", sessionId: SESSION } };
  const paseo = { agents: { list: async () => ({ entries: [{ agent }] }), ref: () => ({ refresh: async () => null, current: () => agent }) } };

  // Active runs keep a fresh heartbeat, as their runner would, so none reads as stale.
  const heartbeat = setInterval(() => {
    for (const id of fs.readdirSync(runsDir)) {
      const file = path.join(runsDir, id, "run.json");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      if (state.status === "running" || state.status === "waiting") {
        state.heartbeatMs = Date.now();
        fs.writeFileSync(file, JSON.stringify(state, null, 2));
      }
    }
  }, 2000);

  // A pi for the RPC probes: it lists no commands and runs nothing else.
  const fakePi = path.join(root, "bin", "pi");
  write(fakePi, `#!${process.execPath}
if (!process.argv.includes("rpc")) process.exit(1);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    console.log(JSON.stringify({ type: "response", id: message.id, success: true, data: message.type === "get_commands" ? { commands: [] } : {} }));
  }
});
process.stdin.on("end", () => process.exit(0));
`);
  fs.chmodSync(fakePi, 0o755);

  return {
    root,
    agentDir,
    fakePi,
    paseo,
    cleanup() {
      clearInterval(heartbeat);
      try {
        process.kill(-sleeper.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Paseo workspaces as the SDK lists them. */
export const workspaces = [
  { id: "wks-acme-main", projectId: "p-acme", projectDisplayName: "acme-api", projectRootPath: MAIN, workspaceDirectory: MAIN, workspaceKind: "local_checkout", name: "main", title: null, gitRuntime: { currentBranch: "main", isDirty: false } },
  {
    id: "wks-acme-rate",
    projectId: "p-acme",
    projectDisplayName: "acme-api",
    projectRootPath: MAIN,
    workspaceDirectory: WORKTREE,
    workspaceKind: "worktree",
    name: "brave-otter",
    title: null,
    gitRuntime: { currentBranch: "feat/rate-limits", isPaseoOwnedWorktree: true, isDirty: true },
    githubRuntime: { pullRequest: { number: 212, title: "Rate limit the public API", url: "https://github.com/acme/acme-api/pull/212", state: "open" } },
  },
  { id: "wks-acme-auth", projectId: "p-acme", projectDisplayName: "acme-api", projectRootPath: MAIN, workspaceDirectory: WORKTREE2, workspaceKind: "worktree", name: "calm-heron", title: null, gitRuntime: { currentBranch: "fix/auth-timeout", isPaseoOwnedWorktree: true, isDirty: false }, githubRuntime: { pullRequest: { number: 214, title: "Raise the auth timeout", url: "https://github.com/acme/acme-api/pull/214", state: "open" } } },
  { id: "wks-web-main", projectId: "p-web", projectDisplayName: "web-app", projectRootPath: WEB, workspaceDirectory: WEB, workspaceKind: "local_checkout", name: "main", title: null, gitRuntime: { currentBranch: "main", isDirty: false } },
];

const extensionNames = [
  ["ask-user-question", true],
  ["background-tasks", true],
  ["claude-marketplace", true],
  ["compact-tui", true],
  ["compactor", true],
  ["context-include", true],
  ["deferred", true],
  ["goal", true],
  ["hooks", true],
  ["permissions", false],
  ["statusline", true],
  ["subagents", true],
  ["timers", true],
  ["todo", true],
  ["web-search", true],
  ["workflows", true],
];

const marketplace = [
  ["background-tasks", "Durable background shell jobs with output and task management.", "v0.5.13"],
  ["chrome", "Control Chrome through the DevTools Protocol with session authorization.", null],
  ["goal", "Persistent goals, task trees, autonomous continuation, and completion audits.", "v0.5.13"],
  ["lens", "Post-write formatters, linters, type checks, LSP diagnostics and a read-before-edit guard.", null],
  ["ollama", "Discovers models from a local Ollama, registers the ollama provider, and manages models with /ollama.", null],
  ["rewind", "Per-turn shadow git checkpoints and conversation restoration.", null],
  ["subagents", "Subagents with their own models, tools, and sessions, in the foreground or background.", "v0.5.12"],
  ["timers", "Sleep, heartbeats, and cron schedules that wake the agent.", "v0.5.13"],
  ["todo", "Phased todo plans with dependencies, per-subagent scopes, a widget above the editor, and /todos.", "v0.5.13"],
  ["workflows", "Fixed and dynamic multi-agent workflows with per-step models, tools, skills, MCP servers, and approvals.", "v0.5.13"],
];

/** Canned answers for the RPCs that would otherwise run pi on the rendering machine. */
export function fixtures(now = Date.now()) {
  return {
    "pi.overview": () => ({
      pi: { path: `${HOME}/.local/bin/pi`, version: "0.12.10", error: null },
      agentDir: `${HOME}/.pi/agent`,
      defaults: { provider: "anthropic", model: "claude-opus-5-5", thinking: "medium" },
      workflows: { installed: true, version: "0.5.13", runner: `${HOME}/.pi/agent/marketplace/bin/v0.5.13/pi-rust-ext workflows`, error: null },
      runs: { active: 3, approvals: 1 },
      pid: 4242,
    }),
    "pi.doctor": () => ({
      report: {
        ok: true,
        target: "aarch64-apple-darwin",
        install: { method: "release" },
        path: { shadowed: false },
        config: { files: [{ name: "settings", path: `${HOME}/.pi/agent/settings.json`, exists: true, errors: [] }] },
        auth: { providers: [{ provider: "anthropic", authType: "oauth" }, { provider: "openai-codex", authType: "oauth" }, { provider: "xai", authType: "api_key" }] },
        mcp: { servers: [{ name: "context7", enabled: true, transport: "http" }, { name: "github", enabled: true, transport: "stdio" }, { name: "playwright", enabled: false, transport: "stdio" }] },
        problems: [],
        warnings: [],
      },
      error: null,
    }),
    "pi.usage": () => ({
      report: {
        providers: [
          { provider: "anthropic", plan: "max", windows: [{ label: "5-hour", usedPercent: 18, resetsAt: new Date(now + 3 * 3600_000).toISOString() }, { label: "Weekly", usedPercent: 42, resetsAt: new Date(now + 4 * 86_400_000).toISOString() }] },
          { provider: "openai-codex", plan: "pro", windows: [{ label: "Weekly", usedPercent: 23, resetsAt: new Date(now + 5 * 86_400_000).toISOString() }] },
        ],
      },
      error: null,
    }),
    "pi.stats": () => ({
      report: {
        sessions: 64,
        prompts: 311,
        assistantTurns: 5204,
        cost: 286.41,
        tokens: { total: 912_400_000 },
        byModel: [
          { name: "anthropic/claude-opus-5-5", sessions: 31, cost: 171.2, tokens: { total: 521_300_000 } },
          { name: "openai/gpt-6.1-terra", sessions: 18, cost: 72.85, tokens: { total: 248_900_000 } },
          { name: "anthropic/claude-haiku-5-5", sessions: 9, cost: 21.06, tokens: { total: 96_400_000 } },
          { name: "xai/grok-4.7", sessions: 6, cost: 21.3, tokens: { total: 45_800_000 } },
        ],
      },
      error: null,
    }),
    "pi.models": () => ({
      models: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "openai/gpt-6.1-terra", "openai/gpt-6.1-sol", "xai/grok-4.7"].map((id) => {
        const [provider, model] = id.split("/");
        return { provider, id: model, context: "1M", maxOut: "128K", thinking: true, images: true };
      }),
      error: null,
    }),
    "pi.sessions.list": () => ({
      sessions: [
        [WORKTREE, "Rate limit the public API per key", 214, 8.12, 0.2],
        [WORKTREE, "Why does the limiter reset early on Redis failover?", 63, 2.4, 3],
        [WORKTREE2, "Raise the auth token timeout to 30 minutes", 88, 3.05, 1],
        [MAIN, "Add request IDs to every log line", 146, 5.6, 26],
        [MAIN, "Summarize last week's incidents", 22, 0.41, 50],
        [WEB, "Fix the layout shift on the pricing page", 71, 2.18, 30],
      ].map(([cwd, first, count, cost, hours], index) => ({
        id: `01a1c0de-0000-7000-8000-00000000000${index}`,
        shortId: `01a1c0de-${index}`,
        path: `${HOME}/.pi/agent/sessions/s${index}.jsonl`,
        cwd,
        name: null,
        firstMessage: first,
        created: new Date(now - (hours + 2) * 3600_000).toISOString(),
        modified: new Date(now - hours * 3600_000).toISOString(),
        messageCount: count,
        cost,
      })),
    }),
    "ext.list": () => ({
      extensions: [
        ...extensionNames.map(([name, enabled]) => ({ reference: `native:@pi-rust-extensions/${name}/${name}`, name, enabled, source: `marketplace:${name}`, builtin: false })),
        { reference: "builtin:mcp", name: "mcp", enabled: true, source: "builtin", builtin: true },
        { reference: "builtin:codemode", name: "codemode", enabled: true, source: "builtin", builtin: true },
      ],
      packages: extensionNames.map(([name]) => ({ source: `marketplace:${name}`, path: `${HOME}/.pi/agent/marketplace/packages/${name}`, filtered: name === "permissions", scope: "global" })),
    }),
    "ext.search": () => ({ results: marketplace.map(([name, description, installed]) => ({ name, version: "0.5.13", installed, description })), error: null }),
    "ext.info": ({ name }) => ({ title: name, description: marketplace.find(([n]) => n === name)?.[1] ?? "", fields: { Version: "0.5.13", Install: `pi install marketplace:${name}` }, text: name }),
    "wf.catalog": () => ({
      skills: ["code-review", "release-notes", "workflow-create", "workflow-optimize"],
      mcpServers: ["context7", "github", "playwright"],
      subagents: ["explore", "build", "advisor"],
      models: ["anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5", "openai/gpt-6.1-terra"],
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      error: null,
    }),
    "ext.commands": () => ({
      commands: [
        ["deferred", "Browse and change what is deferred, or: [status|reload|reset|set <kind> <pattern> <mode>|unset <kind> <pattern>] [--project|--repo <owner/name>]", "deferred"],
        ["goal", "Start a guided goal draft", "goal"],
        ["goal-status", "Show the focused goal, its tasks, and its health", "goal"],
        ["todos", "Show and change the todo plan", "todo"],
        ["tasks", "Open the background task manager", "background-tasks"],
        ["bg-clear", "Remove finished background tasks and their output", "background-tasks"],
        ["timers", "List heartbeats and schedules", "timers"],
      ].map(([name, description, ext]) => ({ name, description, extension: `native:@pi-rust-extensions/${ext}/${ext}` })),
      error: null,
    }),
    "ext.command.run": ({ command }) => ({
      disposition: "handled",
      agentInvoked: false,
      neededUi: false,
      output: [
        {
          level: "info",
          text:
            command === "deferred"
              ? "deferred config: setting `deferred`\nauto: extension and MCP tools load as names past 10% of the context window\nrepo: acme/acme-api (origin)\nrules: 21\nlast prompt: 34 tools (12 names, 9 deferred, 1 off), 18 skills (16 names, 1 user), 1 context file deferred\nkept out of the prompt: ~41.2k tokens\nloaded this session: mcp__github__create_pull_request"
              : `/${command} ran.`,
        },
      ],
    }),
    "pi.settings.read": () => ({ path: `${HOME}/.pi/agent/settings.json`, exists: true, text: '{\n  "defaultProvider": "anthropic",\n  "defaultModel": "claude-opus-5-5"\n}\n' }),
  };
}
