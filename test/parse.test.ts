import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExtensionList, parseInfo, parseModels, parsePackageList, parseSearch } from "../server/parse";
import { stripAnsi } from "../server/pi";
import { parseExtensionCommand, parseWorkflowCommand, tokenize } from "../shared/slash";
import { statsRowName } from "../shared/stats";

test("pi extensions list", () => {
  const text = [
    "Extensions ([x] enabled, [ ] disabled):",
    "[x] native:@pi-rust-extensions/todo/todo  (marketplace:todo)",
    "[ ] native:@pi-rust-extensions/permissions/permissions  (marketplace:permissions)",
    "[x] builtin:mcp  (builtin)",
    "[x] /home/me/.pi/agent/extensions/my-ext.ts  (auto)",
  ].join("\n");
  assert.deepEqual(parseExtensionList(text), [
    { reference: "native:@pi-rust-extensions/todo/todo", name: "todo", enabled: true, source: "marketplace:todo", builtin: false },
    { reference: "native:@pi-rust-extensions/permissions/permissions", name: "permissions", enabled: false, source: "marketplace:permissions", builtin: false },
    { reference: "builtin:mcp", name: "mcp", enabled: true, source: "builtin", builtin: true },
    { reference: "/home/me/.pi/agent/extensions/my-ext.ts", name: "my-ext", enabled: true, source: "auto", builtin: false },
  ]);
  assert.deepEqual(parseExtensionList("Extensions ([x] enabled, [ ] disabled):\nNo extensions found."), []);
});

test("pi list", () => {
  const text = [
    "User packages:",
    "  marketplace:statusline",
    "    /home/me/.pi/agent/marketplace/packages/statusline",
    "  marketplace:iterm2 (filtered)",
    "    /home/me/.pi/agent/marketplace/packages/iterm2",
    "  npm:@foo/bar",
    "",
    "Project packages:",
    "  git:github.com/me/ext",
    "    /work/.pi/git/ext",
  ].join("\n");
  assert.deepEqual(parsePackageList(text), [
    { source: "marketplace:statusline", path: "/home/me/.pi/agent/marketplace/packages/statusline", filtered: false, scope: "global" },
    { source: "marketplace:iterm2", path: "/home/me/.pi/agent/marketplace/packages/iterm2", filtered: true, scope: "global" },
    { source: "npm:@foo/bar", path: null, filtered: false, scope: "global" },
    { source: "git:github.com/me/ext", path: "/work/.pi/git/ext", filtered: false, scope: "project" },
  ]);
  assert.deepEqual(parsePackageList("No packages installed."), []);
});

test("pi extensions search and info", () => {
  const search = "todo (0.5.13) [installed: v0.5.13]\n  Phased todo plans.\nlens (0.5.13)\n  Formatters and linters.";
  assert.deepEqual(parseSearch(search), [
    { name: "todo", version: "0.5.13", installed: "v0.5.13", description: "Phased todo plans." },
    { name: "lens", version: "0.5.13", installed: null, description: "Formatters and linters." },
  ]);
  assert.deepEqual(parseSearch("No marketplace extensions found."), []);
  const info = parseInfo("Todo (todo)\nPhased todo plans with dependencies.\nVersion: 0.5.13\nInstalled: v0.5.13\nTags: tui, tool\nInstall: pi install marketplace:todo");
  assert.equal(info.title, "Todo (todo)");
  assert.equal(info.description, "Phased todo plans with dependencies.");
  assert.deepEqual(info.fields, { Version: "0.5.13", Installed: "v0.5.13", Tags: "tui, tool", Install: "pi install marketplace:todo" });
});

test("pi --list-models", () => {
  const text = "provider   model   context  max-out  thinking  images\nanthropic  claude-x  200K  64K  yes  no\n";
  assert.deepEqual(parseModels(text), [{ provider: "anthropic", id: "claude-x", context: "200K", maxOut: "64K", thinking: true, images: false }]);
});

test("ANSI escapes are stripped", () => {
  assert.equal(stripAnsi("\x1b[1mUser packages:\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07"), "User packages: link");
});

test("slash commands tokenize quotes and parse subcommands", () => {
  assert.deepEqual(tokenize(`run ship change="fix the \\"login\\" bug" base='origin/main'`), ["run", "ship", 'change=fix the "login" bug', "base=origin/main"]);
  assert.deepEqual(parseWorkflowCommand(`run ship change="a b" --fg`), { kind: "run", name: "ship", inputs: { change: "a b" }, background: false });
  assert.deepEqual(parseWorkflowCommand(""), { kind: "open" });
  assert.deepEqual(parseWorkflowCommand("approve"), { kind: "approve", id: null, decision: "run" });
  assert.deepEqual(parseWorkflowCommand("approve wf-abc skip"), { kind: "approve", id: "wf-abc", decision: "skip" });
  assert.deepEqual(parseWorkflowCommand("stop wf-1"), { kind: "control", action: "stop", id: "wf-1" });
  assert.throws(() => parseWorkflowCommand("run ship oops"), /key=value/);
  assert.throws(() => parseWorkflowCommand("explode"), /Unknown subcommand/);
  assert.deepEqual(parseExtensionCommand("install marketplace:todo -l"), { kind: "action", action: "install", target: "marketplace:todo", project: true });
  assert.deepEqual(parseExtensionCommand(""), { kind: "open" });
  assert.throws(() => parseExtensionCommand("enable"), /Usage/);
});

test("/workflow run takes --worktree with an optional branch", () => {
  assert.deepEqual(parseWorkflowCommand(`run ship change="x" --worktree`), { kind: "run", name: "ship", inputs: { change: "x" }, background: undefined, worktree: { branch: null } });
  assert.deepEqual(parseWorkflowCommand(`run ship --worktree=feat/limits`), { kind: "run", name: "ship", inputs: {}, background: undefined, worktree: { branch: "feat/limits" } });
});

test("pi stats rows are named by their name field", () => {
  assert.equal(statsRowName({ name: "anthropic/claude-opus-5-5", cost: 372.09 }), "anthropic/claude-opus-5-5");
  assert.equal(statsRowName({ provider: "openai", model: "gpt-6" }), "openai/gpt-6");
  assert.equal(statsRowName({}), "unknown");
});
