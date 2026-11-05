// Extension commands through a fake pi, extension config files, and the rules of `deferred`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { pluginSettings } from "../shared/contracts";
import { canonicalMode, contextMatch, decide, globMatch, modesFor, type Rule } from "../shared/deferred";
import { applySettings } from "../server/pi";
import {
  deferredConfig,
  deferredOptions,
  deferredSet,
  extensionCommands,
  readExtensionConfig,
  repoFromRemote,
  runExtensionCommand,
  writeExtensionConfig,
} from "../server/extensions";

const root = mkdtempSync(path.join(tmpdir(), "pi-rust-ext-"));
const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
const fakePi = path.join(root, "pi");

// Answers get_commands, runs `/echo <args>` as a notify, and starts a turn for `/turn`.
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
      { name: "echo", description: "Says it back", source: "extension", sourceInfo: { path: "native:@x/echo/echo" } },
      { name: "turn", description: "Starts a turn", source: "extension", sourceInfo: { path: "native:@x/echo/echo" } },
      { name: "mcp", description: "Built in", source: "extension", sourceInfo: { path: "builtin:mcp" } },
      { name: "skill:review", description: "A skill", source: "skill", sourceInfo: { path: "/s/SKILL.md" } },
    ] } });
    if (msg.type === "prompt" && msg.message.startsWith("/echo")) {
      out({ type: "extension_ui_request", id: "n1", method: "notify", notifyType: "info", message: "you said: " + msg.message.slice(6) });
      out({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?" });
      out({ type: "response", id: msg.id, success: true, data: { disposition: "handled", agentInvoked: false } });
    }
    if (msg.type === "prompt" && msg.message.startsWith("/turn")) out({ type: "response", id: msg.id, success: true, data: { disposition: "handled", agentInvoked: true } });
    if (msg.type === "abort") out({ type: "response", id: msg.id, success: true });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

before(() => {
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi });
});

test("extension commands list and run headlessly", async () => {
  const { commands, error } = await extensionCommands({ cwd: project });
  assert.equal(error, null);
  assert.deepEqual(commands.map((c) => c.name), ["echo", "turn"]);
  const echoed = await runExtensionCommand({ cwd: project, command: "echo", args: "  hello  " });
  assert.deepEqual(echoed, { disposition: "handled", agentInvoked: false, output: [{ level: "info", text: "you said: hello" }], neededUi: true });
  const turn = await runExtensionCommand({ cwd: project, command: "turn", args: "" });
  assert.equal(turn.agentInvoked, true);
  await assert.rejects(runExtensionCommand({ cwd: project, command: "skill:review", args: "" }), /not a command of an installed extension/);
});

test("extension config files read and write as JSON objects", async () => {
  const before = await readExtensionConfig({ name: "web-search", cwd: project });
  assert.deepEqual(before.files.map((f) => [f.scope, f.exists]), [["global", false], ["project", false]]);
  await writeExtensionConfig({ name: "web-search", scope: "global", text: '{"engine": "brave"}' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "ext", "web-search.json"), "utf8")), { engine: "brave" });
  await assert.rejects(writeExtensionConfig({ name: "web-search", scope: "global", text: "[1]" }), /JSON object/);
  await assert.rejects(writeExtensionConfig({ name: "../evil", scope: "global", text: "{}" }), /Invalid extension name/);
});

test("deferred modes, globs, and context paths match the extension", () => {
  assert.equal(canonicalMode("defer"), "deferred");
  assert.equal(canonicalMode("name-only"), "names");
  assert.equal(canonicalMode("nope"), null);
  assert.deepEqual(modesFor("tools"), ["on", "names", "deferred", "off"]);
  assert.ok(globMatch("mcp__*", "mcp__github__create_issue"));
  assert.ok(globMatch("bg_?un", "bg_run"));
  assert.ok(!globMatch("mcp__github__*", "mcp__gitlab__x"));
  assert.ok(contextMatch("AGENTS.md", "/work/app/AGENTS.md"));
  assert.ok(contextMatch("docs/AGENTS.md", "/work/app/docs/AGENTS.md"));
  assert.ok(!contextMatch("/other/AGENTS.md", "/work/app/AGENTS.md"));
  assert.equal(repoFromRemote("git@github.com:yannelli/pi-rust.git\n"), "yannelli/pi-rust");
  assert.equal(repoFromRemote("https://github.com/yannelli/pi-rust"), "yannelli/pi-rust");
  assert.equal(repoFromRemote("ssh://git@github.com/yannelli/pi-rust.git"), "yannelli/pi-rust");
});

test("deferred rules come from every source in order, and the last match wins", async () => {
  execFileSync("git", ["-C", project, "init", "-q"]);
  execFileSync("git", ["-C", project, "remote", "add", "origin", "git@github.com:acme/api.git"]);
  writeFileSync(path.join(agentDir, "ext", "deferred.json"), JSON.stringify({ tools: { "mcp__*": "names" }, repos: { "acme/*": { tools: { web_fetch: "off" } } } }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "x", deferred: { tools: { "mcp__github__*": "defer" }, skills: { "*": "names" }, auto: 15 } }));
  await deferredSet({ cwd: project, scope: "project", kind: "skills", pattern: "commit", mode: "on" });
  await deferredSet({ cwd: project, scope: "repo", kind: "tools", pattern: "mcp__github__delete_repo", mode: "off" });
  await deferredSet({ scope: "repo", repo: "other/repo", kind: "tools", pattern: "web_search", mode: "off" });

  // The workspace rule created .pi/settings.json, so pi now needs the workspace trusted to read it.
  const untrusted = await deferredConfig({ cwd: project });
  assert.equal(untrusted.trusted, false);
  assert.equal(untrusted.rules.find((r) => r.scope === "project")?.applies, false);
  writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify({ [project]: true }));

  const config = await deferredConfig({ cwd: project });
  assert.equal(config.trusted, true);
  assert.equal(config.repo, "acme/api");
  assert.equal(config.auto, 15);
  assert.equal(config.maxResults, 5);
  assert.deepEqual(
    config.rules.map((r) => `${r.scope}:${r.origin}:${r.kind}:${r.pattern}=${r.mode}${r.applies ? "" : " (inactive)"}`),
    [
      "global:file:tools:mcp__*=names",
      "global:settings:tools:mcp__github__*=deferred",
      "global:settings:skills:*=names",
      "repo:file:tools:web_fetch=off",
      "repo:settings:tools:mcp__github__delete_repo=off",
      "repo:settings:tools:web_search=off (inactive)",
      "project:settings:skills:commit=on",
    ],
  );
  const rules = config.rules as Rule[];
  assert.equal(decide(rules, "tools", "mcp__github__create_issue")?.mode, "deferred");
  assert.equal(decide(rules, "tools", "mcp__github__delete_repo")?.mode, "off");
  assert.equal(decide(rules, "tools", "mcp__linear__list")?.mode, "names");
  assert.equal(decide(rules, "tools", "web_search"), null);
  assert.equal(decide(rules, "skills", "commit")?.scope, "project");
  assert.equal(decide(rules, "skills", "review")?.mode, "names");

  // Settings keep their other keys; removing the last rule removes the empty blocks.
  await deferredSet({ cwd: project, scope: "repo", kind: "tools", pattern: "mcp__github__delete_repo", mode: null });
  await deferredSet({ scope: "repo", repo: "other/repo", kind: "tools", pattern: "web_search", mode: null });
  const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "x");
  assert.equal(settings.deferred.repos, undefined);
  await assert.rejects(deferredSet({ scope: "global", kind: "tools", pattern: "x", mode: "user" }), /Only skills/);
  await deferredOptions({ auto: false, maxResults: 8 });
  const after = await deferredConfig({ cwd: project });
  assert.deepEqual([after.auto, after.maxResults], [false, 8]);
});
