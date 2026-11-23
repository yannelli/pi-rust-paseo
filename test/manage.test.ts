// Sign-in checks and stats through a fake pi: the arguments pi gets and how its answers parse.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { authCheckRpc, pluginSettings, statsRpc } from "../shared/contracts";
import { authCheck, authCheckArgs, stats } from "../server/manage";
import { applySettings } from "../server/pi";

const root = mkdtempSync(path.join(tmpdir(), "pi-rust-manage-"));
const agentDir = path.join(root, "agent");
const fakePi = path.join(root, "pi");
const calls = path.join(root, "calls.log");

// Logs its arguments, answers `auth check` as pi 0.12.33 does, and echoes `stats` arguments.
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const answer = (code, value) => { process.stdout.write(JSON.stringify(value) + "\\n"); process.exit(code); };
if (args[0] === "stats") answer(0, { argv: args });
const provider = flag("--provider");
if (provider === "anthropic") answer(0, { status: "ready", provider, authType: "oauth" });
if (provider === "groq") answer(1, { status: "not_ready", provider, reason: "credentials_not_configured" });
if (provider === "broken") { process.stderr.write("Error: models.json is not readable\\n"); process.exit(2); }
answer(2, { status: "invalid", provider: flag("--model"), reason: "invalid_state" });
`;

before(() => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi });
});

test("auth checks pass the provider and model read-only, never asking for credentials", () => {
  assert.deepEqual(authCheckArgs({ provider: "anthropic", model: null }), ["auth", "check", "--provider", "anthropic", "--json", "--no-refresh"]);
  assert.deepEqual(authCheckArgs({ provider: "anthropic", model: "claude-opus-5-5" }), [
    "auth",
    "check",
    "--provider",
    "anthropic",
    "--model",
    "claude-opus-5-5",
    "--json",
    "--no-refresh",
  ]);
  assert.deepEqual(authCheckArgs({ provider: null, model: "openai/gpt-6" }), ["auth", "check", "--model", "openai/gpt-6", "--json", "--no-refresh"]);
  assert.equal(authCheckRpc.input.safeParse({ targets: [{ provider: "--credentials", model: null }] }).success, false);
  assert.equal(authCheckRpc.input.safeParse({ targets: [{ provider: null, model: null }] }).success, false);
});

test("auth check answers parse with every exit code, in the order of the targets", async () => {
  const { results } = await authCheck({
    targets: [
      { provider: "anthropic", model: null },
      { provider: "groq", model: null },
      { provider: null, model: "claude-x" },
      { provider: "broken", model: null },
    ],
  });
  assert.deepEqual(results, [
    { status: "ready", provider: "anthropic", authType: "oauth", reason: null, error: null },
    { status: "not_ready", provider: "groq", authType: null, reason: "credentials_not_configured", error: null },
    { status: "invalid", provider: "claude-x", authType: null, reason: "invalid_state", error: null },
    { status: "failed", provider: "broken", authType: null, reason: null, error: "models.json is not readable" },
  ]);
  const logged = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.ok(logged.every((args) => !args.includes("--credentials") && args[1] === "check"));
});

test("stats pass --all and --since, and the RPC rejects a malformed period", async () => {
  const { report } = await stats({ all: true, since: "7d" });
  assert.deepEqual(report?.argv, ["stats", "--json", "--all", "--since", "7d"]);
  assert.deepEqual((await stats({ all: false })).report?.argv, ["stats", "--json"]);
  assert.equal(statsRpc.input.safeParse({ all: true, since: "7 days" }).success, false);
  assert.equal(statsRpc.input.safeParse({ all: true, since: "--all" }).success, false);
});
