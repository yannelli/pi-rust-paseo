// System prompt and context files, skills and prompt templates (discovery, settings filters,
// create, delete), the file allowlist, and Claude plugins, over temporary directories and a fake pi.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { claudeArgs } from "../shared/claude";
import { pluginSettings } from "../shared/contracts";
import { parseFrontmatter, skillNameError, yamlScalar } from "../shared/resources";
import { claudeRun, claudeState, resourcesOf, sourceKind } from "../server/claude";
import { applySettings } from "../server/pi";
import {
  context,
  createPrompt,
  createSkill,
  deleteFile,
  deleteSkill,
  enabledByEntries,
  globRegex,
  prompts,
  readResource,
  skills,
  toggledEntries,
  toggleResource,
  writeFile,
} from "../server/resources";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-rust-res-")));
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
const project = path.join(home, "code", "app");
const packageSkill = path.join(agentDir, "npm", "node_modules", "pkg", "skills", "from-package", "SKILL.md");
const fakePi = path.join(root, "pi");

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function skill(dir: string, name: string, description: string, extra = "") {
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody of ${name}.\n`);
}

// Lists one skill from a package, and answers `/claude-plugins <args>` with a notice.
const FAKE_PI = `#!/usr/bin/env node
let buffer = "";
const out = (record) => console.log(JSON.stringify(record));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (msg.type === "get_commands") out({ type: "response", id: msg.id, success: true, data: { commands: [
      { name: "skill:from-package", description: "Packaged", source: "skill", sourceInfo: { path: ${JSON.stringify(packageSkill)}, source: "npm:pkg", scope: "user" } },
      { name: "skill:commit", description: "Found by pi too", source: "skill", sourceInfo: { path: ${JSON.stringify(path.join(agentDir, "skills", "commit", "SKILL.md"))}, source: "auto", scope: "user" } },
    ] } });
    if (msg.type === "prompt") {
      const failing = msg.message.includes("missing@");
      out({ type: "extension_ui_request", id: "n", method: "notify", notifyType: failing ? "error" : "info", message: failing ? "no plugin missing@x" : "ran " + msg.message });
      out({ type: "response", id: msg.id, success: true, data: { disposition: "handled", agentInvoked: false } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

before(() => {
  process.env.HOME = home;
  mkdirSync(path.join(project, ".git"), { recursive: true });
  write(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi });
  write(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", skills: ["-skills/old/SKILL.md"] }));

  // Context: the agent directory's file, one above the project, and the project's with includes.
  write(path.join(agentDir, "AGENTS.md"), "# Global\n");
  write(path.join(home, "code", "CLAUDE.md"), "# Code\n");
  write(path.join(project, "AGENTS.md"), "# App\n\n@docs/arch.md\n- @~/notes.md\n```\n@not/an/include.md\n```\n");
  write(path.join(project, "docs", "arch.md"), "# Arch\n");
  write(path.join(agentDir, "APPEND_SYSTEM.md"), "Be brief.\n");
  write(path.join(project, ".pi", "SYSTEM.md"), "You are terse.\n");

  // Skills: pi's own (one off by a settings entry), ~/.agents, the project's, a duplicate name.
  skill(path.join(agentDir, "skills"), "commit", "Commits.");
  skill(path.join(agentDir, "skills"), "old", "Old one.");
  // A root Markdown file is a skill when it has a description; pi names it after its directory.
  write(path.join(agentDir, "skills", "single.md"), "---\ndescription: A single-file skill\n---\n\nHi.\n");
  write(path.join(agentDir, "skills", "notes.md"), "No front matter, not a skill.\n");
  skill(path.join(home, ".agents", "skills"), "review", "Reviews.", "disable-model-invocation: true\n");
  write(path.join(home, ".agents", "skills", "loose.md"), "---\ndescription: Root files do not count in .agents\n---\n");
  skill(path.join(project, ".pi", "skills"), "commit", "The project's commit.");
  skill(path.join(project, ".agents", "skills"), "Bad_Name", "Breaks the name rules.");
  write(packageSkill, "---\nname: from-package\ndescription: Packaged\n---\n");

  // Prompt templates.
  write(path.join(agentDir, "prompts", "review.md"), "---\ndescription: Review it\nargument-hint: \"[focus]\"\n---\n\nReview $ARGUMENTS\n");
  write(path.join(agentDir, "prompts", "plain.md"), "\nFirst line of a template without front matter that runs long enough to be cut off\n");

  // Claude plugins: one marketplace, one installed plugin with staged files, one available, one npm.
  const claude = path.join(agentDir, "ext", "claude-marketplace");
  const market = path.join(claude, "sources", "market");
  write(
    path.join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "market",
      description: "A market",
      owner: { name: "Acme" },
      plugins: [
        { name: "helper", description: "Helps", version: "1.0.0", source: "./plugins/helper", category: "git" },
        { name: "remote", description: "Far away", source: { source: "github", repo: "acme/remote" } },
        { name: "npm-one", source: { source: "npm", package: "x" } },
      ],
    }),
  );
  const staged = path.join(claude, "resources", "skills", "helper-commit");
  skill(path.join(claude, "resources", "skills"), "helper-commit", "From a plugin.");
  write(path.join(claude, "resources", "prompts", "helper:go.md"), "---\ndescription: Go\n---\n\nGo.\n");
  write(
    path.join(claude, "state.json"),
    JSON.stringify({
      marketplaces: { market: { name: "market", source: "acme/market", gitUrl: "https://github.com/acme/market.git", root: market, manifest: path.join(market, ".claude-plugin", "marketplace.json") } },
      plugins: {
        "helper@market": {
          plugin: "helper",
          marketplace: "market",
          marketplaceScope: "user",
          version: "1.0.1",
          enabled: true,
          pluginRoot: path.join(market, "plugins", "helper"),
          files: [staged, path.join(claude, "resources", "prompts", "helper:go.md"), path.join(agentDir, "ext", "subagents", "agents", "helper-bot.md")],
          hooks: true,
          mcpKeys: ["plugin_helper_db"],
          unsupported: ["outputStyles"],
        },
      },
    }),
  );
  write(path.join(agentDir, "ext", "claude-marketplace.json"), JSON.stringify({ marketplaces: { market: { source: "acme/market", autoUpdate: true }, pending: { source: "acme/pending" } }, plugins: { "helper@market": { enabled: true } } }));
});

test("front matter: plain, quoted, and block values", () => {
  const { fields, body } = parseFrontmatter('---\nname: x\ndescription: >\n  Folded\n  text\nhint: "[a]"\nlong: one\n  two\n---\nBody\n');
  assert.deepEqual(fields, { name: "x", description: "Folded text", hint: "[a]", long: "one two" });
  assert.equal(body, "Body\n");
  assert.equal(parseFrontmatter("No front matter").body, "No front matter");
  assert.equal(yamlScalar("Plain words."), "Plain words.");
  assert.equal(yamlScalar("Has: a colon"), '"Has: a colon"');
  assert.equal(skillNameError("good-name-2"), null);
  assert.ok(skillNameError("Bad_Name"));
  assert.ok(skillNameError("a--b"));
});

test("settings filters match pi's: ! globs, exact + and -, relative or absolute", () => {
  const base = "/a/agent";
  const file = "/a/agent/skills/x/SKILL.md";
  assert.ok(globRegex("skills/*/SKILL.md").test("skills/x/SKILL.md"));
  assert.ok(!globRegex("skills/*").test("skills/x/SKILL.md"));
  assert.ok(globRegex("**/x").test("skills/x"));
  assert.equal(enabledByEntries(file, [], base), true);
  assert.equal(enabledByEntries(file, ["-skills/x/SKILL.md"], base), false);
  assert.equal(enabledByEntries(file, ["-skills/x"], base), false, "the skill's directory names it too");
  assert.equal(enabledByEntries(file, ["!skills/*/SKILL.md"], base), false);
  assert.equal(enabledByEntries(file, ["!skills/*/SKILL.md", "+/a/agent/skills/x/SKILL.md"], base), true);
  assert.equal(enabledByEntries(file, ["-skills/y/SKILL.md"], base), true);
  assert.deepEqual(toggledEntries(["-skills/x/SKILL.md", "other"], file, base, true), ["other"]);
  assert.deepEqual(toggledEntries([], file, base, false), ["-/a/agent/skills/x/SKILL.md"]);
  assert.deepEqual(toggledEntries(["!skills/*"], file, base, false), ["!skills/*"], "the directory already matches");
  assert.deepEqual(toggledEntries(["!skills/*"], file, base, true), ["!skills/*", "+/a/agent/skills/x/SKILL.md"]);
});

test("context lists the prompt files in use and the context files in pi's order", async () => {
  const result = await context({ cwd: project });
  assert.equal(result.system.active, "project");
  assert.equal(result.append.active, "global");
  // Context files above the temporary root (such as a stray /tmp/AGENTS.md) are the machine's.
  const ours = result.contextFiles.filter((file) => file.path.startsWith(root));
  assert.deepEqual(
    ours.map((file) => [file.origin, path.relative(home, file.path)]),
    [
      ["agent", ".pi/agent/AGENTS.md"],
      ["parent", "code/CLAUDE.md"],
      ["workspace", "code/app/AGENTS.md"],
    ],
  );
  const includes = ours[2].includes;
  assert.deepEqual(
    includes.map((include) => [include.ref, include.exists]),
    [
      ["docs/arch.md", true],
      ["~/notes.md", false],
    ],
  );
  assert.equal(includes[1].path, path.join(home, "notes.md"));
  assert.deepEqual(result.missing, []);
  const global = await context({});
  assert.equal(global.system.active, "default");
  assert.equal(global.contextFiles.filter((file) => file.path.startsWith(root)).length, 1);
});

test("skills come from every place pi reads, ranked, with settings filters and plugins", async () => {
  const result = await skills({ cwd: project, refresh: true });
  const find = (name: string, location?: string) => result.skills.find((entry) => entry.name === name && (!location || entry.location === location));
  assert.deepEqual(
    result.skills.map((entry) => `${entry.location}:${entry.name}`),
    ["other:from-package", "project:commit", "project-agents:Bad_Name", "agent:commit", "agent:old", "agent:skills", "agents-home:review", "claude-plugin:helper-commit"],
  );
  assert.equal(find("old")?.enabled, false);
  assert.equal(find("commit", "agent")?.shadowedBy, path.join(project, ".pi", "skills", "commit", "SKILL.md"));
  assert.equal(find("commit", "project")?.shadowedBy, null);
  assert.ok(find("Bad_Name")?.warnings[0]?.startsWith("Name"));
  assert.equal(find("review")?.manualOnly, true);
  assert.equal(find("helper-commit")?.plugin, "helper@market");
  assert.equal(find("helper-commit")?.toggleable, false);
  assert.equal(find("from-package")?.source, "npm:pkg");
});

test("turning a skill on and off writes the settings entries pi config writes", async () => {
  const old = path.join(agentDir, "skills", "old", "SKILL.md");
  await toggleResource({ cwd: project, kind: "skills", path: old, enabled: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")).skills, undefined);
  const review = path.join(home, ".agents", "skills", "review", "SKILL.md");
  await toggleResource({ cwd: project, kind: "skills", path: review, enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")).skills, [`-${review}`]);
  const projectSkill = path.join(project, ".pi", "skills", "commit", "SKILL.md");
  await toggleResource({ cwd: project, kind: "skills", path: projectSkill, enabled: false });
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, ".pi", "settings.json"), "utf8")).skills, [`-${projectSkill}`]);
  const after = await skills({ cwd: project });
  assert.equal(after.skills.find((entry) => entry.path === projectSkill)?.enabled, false);
  assert.equal(after.skills.find((entry) => entry.location === "agent" && entry.name === "commit")?.shadowedBy, null);
  await assert.rejects(toggleResource({ cwd: project, kind: "skills", path: path.join(agentDir, "ext", "claude-marketplace", "resources", "skills", "helper-commit", "SKILL.md"), enabled: false }));
});

test("prompt templates: names, descriptions, hints, and plugin prompts", async () => {
  const result = await prompts({ cwd: project });
  const byName = Object.fromEntries(result.prompts.map((prompt) => [prompt.name, prompt]));
  assert.equal(byName.review.description, "Review it");
  assert.equal(byName.review.argumentHint, "[focus]");
  assert.equal(byName.plain.description, "First line of a template without front matter that runs long...");
  assert.equal(byName["helper:go"].plugin, "helper@market");
  await toggleResource({ cwd: project, kind: "prompts", path: byName.plain.path, enabled: false });
  assert.equal((await prompts({ cwd: project })).prompts.find((prompt) => prompt.name === "plain")?.enabled, false);
});

test("create, edit, and delete skills, prompts, and prompt files inside pi's folders only", async () => {
  const created = await createSkill({ cwd: project, location: "project-agents", name: "deploy", description: "Deploys: carefully", body: "Steps." });
  assert.equal(created.path, path.join(project, ".agents", "skills", "deploy", "SKILL.md"));
  assert.match(readFileSync(created.path, "utf8"), /^---\nname: deploy\ndescription: "Deploys: carefully"\n---\n\nSteps\.\n$/);
  await assert.rejects(createSkill({ cwd: project, location: "project-agents", name: "deploy", description: "Again", body: "" }), /already exists/);
  const prompt = await createPrompt({ cwd: project, location: "project", name: "ship", description: "Ship it", argumentHint: "[branch]", body: "Ship $1" });
  assert.equal(readFileSync(prompt.path, "utf8"), "---\ndescription: Ship it\nargument-hint: \"[branch]\"\n---\n\nShip $1\n");

  await writeFile({ cwd: project, path: path.join(agentDir, "SYSTEM.md"), text: "New prompt" });
  assert.equal(readFileSync(path.join(agentDir, "SYSTEM.md"), "utf8"), "New prompt\n");
  await writeFile({ cwd: project, path: path.join(home, "code", "CLAUDE.md"), text: "# Code\n" });
  await assert.rejects(writeFile({ cwd: project, path: path.join(home, "elsewhere.md"), text: "x" }), /not a file pi reads/);
  await assert.rejects(writeFile({ cwd: project, path: path.join(agentDir, "settings.json"), text: "{}" }), /Markdown/);
  await assert.rejects(writeFile({ cwd: project, path: path.join(agentDir, "ext", "claude-marketplace", "resources", "skills", "helper-commit", "SKILL.md"), text: "x" }));

  const plugin = await readResource({ cwd: project, path: path.join(agentDir, "ext", "claude-marketplace", "resources", "skills", "helper-commit", "SKILL.md") });
  assert.equal(plugin.editable, false);
  assert.match(plugin.reason ?? "", /Claude plugin/);
  const packaged = await readResource({ cwd: project, path: packageSkill });
  assert.equal(packaged.editable, false);
  await assert.rejects(readResource({ cwd: project, path: path.join(root, "pi") }));

  await deleteSkill({ cwd: project, path: created.path });
  assert.equal(existsSync(path.dirname(created.path)), false);
  await deleteSkill({ cwd: project, path: path.join(agentDir, "skills", "single.md") });
  assert.equal(existsSync(path.join(agentDir, "skills", "single.md")), false);
  await assert.rejects(deleteSkill({ cwd: project, path: path.join(agentDir, "skills") }));
  await deleteFile({ cwd: project, path: prompt.path });
  assert.equal(existsSync(prompt.path), false);
});

test("Claude plugins: marketplaces, statuses, and what installed plugins added", async () => {
  const state = await claudeState({ cwd: project });
  assert.deepEqual(
    state.marketplaces.map((market) => [market.name, market.plugins, market.installed, market.autoUpdate, market.error === null]),
    [
      ["market", 3, 1, true, true],
      ["pending", 0, 0, false, false],
    ],
  );
  const byId = Object.fromEntries(state.plugins.map((plugin) => [plugin.id, plugin]));
  assert.equal(byId["helper@market"].status, "installed");
  assert.equal(byId["helper@market"].version, "1.0.1");
  assert.deepEqual(byId["helper@market"].resources, { skills: ["helper-commit"], commands: ["helper:go"], agents: ["helper-bot"], hooks: true, mcp: ["plugin_helper_db"], unsupported: ["outputStyles"] });
  assert.deepEqual(byId["helper@market"].reasons, ["unsupported: outputStyles"]);
  assert.equal(byId["remote@market"].status, "available");
  assert.equal(byId["remote@market"].remote, true);
  assert.equal(byId["npm-one@market"].status, "unavailable");
  assert.deepEqual(sourceKind("./x"), { remote: false, unsupported: null });
  assert.equal(resourcesOf({ files: [] }).skills.length, 0);
});

test("Claude plugin commands: arguments, scope checks, and the extension's report", async () => {
  assert.equal(claudeArgs("marketplace-add", "acme/market", "project"), "marketplace add acme/market --scope project");
  assert.equal(claudeArgs("install", "a@b", "user"), "install a@b --scope user");
  assert.equal(claudeArgs("disable", "a@b"), "disable a@b");
  assert.equal(claudeArgs("update-all"), "update");
  assert.throws(() => claudeArgs("install"), /Name the plugin/);
  const ok = await claudeRun({ cwd: project, action: "enable", target: "helper@market" });
  assert.deepEqual(ok, { ok: true, output: "ran /claude-plugins enable helper@market", command: "/claude-plugins enable helper@market" });
  const failed = await claudeRun({ cwd: project, action: "uninstall", target: "missing@x" });
  assert.equal(failed.ok, false);
  await assert.rejects(claudeRun({ action: "install", target: "a@b", scope: "project" }), /workspace/);
});
