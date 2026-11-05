// Subscription accounts: the router's files read into accounts, usage, policies, and profiles;
// policies and profiles written as the extension writes them; and /router commands through a fake pi.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { pluginSettings } from "../shared/contracts";
import { DEFAULT_POLICY, parseAccountProvider } from "../shared/router";
import { applySettings } from "../server/pi";
import { newerThan, policyJson, readEntry, readPolicy, routerState, runRouter, saveRouterPolicy, saveRouterProfiles } from "../server/router";

const root = mkdtempSync(path.join(tmpdir(), "pi-rust-router-"));
const agentDir = path.join(root, "agent");
const data = path.join(agentDir, "ext", "subscription-router");
const fakePi = path.join(root, "pi");

// Prints a version, answers get_commands, and answers `/router <args>` with a JSON notice.
const FAKE_PI = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.12.12"); process.exit(0); }
let buffer = "";
const out = (record) => console.log(JSON.stringify(record));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (msg.type === "get_commands") out({ type: "response", id: msg.id, success: true, data: { commands: [] } });
    if (msg.type === "prompt") {
      const args = msg.message.replace(/^\\/router ?/, "");
      const answer = args.startsWith("login start") ? { id: "ab12", provider: "anthropic-3", name: "Anthropic #3", url: "https://claude.ai/oauth/authorize?x", paste: "the code" }
        : args.startsWith("remove") ? { removed: true, provider: args.split(" ")[1] } : null;
      if (args.startsWith("login finish ab12 bad")) out({ type: "extension_ui_request", id: "n", method: "notify", notifyType: "error", message: "State mismatch" });
      else out({ type: "extension_ui_request", id: "n", method: "notify", notifyType: "info", message: answer ? JSON.stringify(answer) : "ran " + args });
      out({ type: "response", id: msg.id, success: true, data: { disposition: "handled" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

before(() => {
  mkdirSync(data, { recursive: true });
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi });
  writeFileSync(
    path.join(agentDir, "ext", "subscription-router.json"),
    JSON.stringify({
      accounts: { anthropic: { strategy: "threshold", switchAt: 85, fallback: [{ model: "openai-codex/gpt-5.5", thinking: "high" }] } },
      profiles: { main: { name: "Main", strategy: "balanced", chain: [{ model: "anthropic-2/claude-opus-5-5" }, { model: "openai-codex/gpt-5.5" }], maxWaitMinutes: 30 } },
      somethingElse: { kept: true },
    }),
  );
  writeFileSync(path.join(data, "accounts.json"), JSON.stringify({ version: 1, accounts: { "anthropic-2": { type: "pi" }, "anthropic-3": { type: "oauth", access: "secret", refresh: "r", expires: 1 }, "openai-codex-2": { type: "pi" } } }));
  writeFileSync(
    path.join(data, "usage.json"),
    JSON.stringify({ version: 1, snapshots: [{ provider: "anthropic-2", status: "available", windows: [{ name: "five_hour", usedPercent: 100, resetAt: Date.now() + 3_600_000, durationMs: 18_000_000, scope: "provider" }], tier: "max", retrievedAt: Date.now(), expiresAt: Date.now() + 300_000 }] }),
  );
  writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a" }, "anthropic-2": { type: "oauth", access: "b" } }));
});

test("accounts, logins, usage, policies, and profiles come from the router's files", async () => {
  const state = await routerState({});
  assert.equal(state.accountsMode, true, "0.12.12 has before_provider_auth");
  const anthropic = state.providers.find((p) => p.base === "anthropic")!;
  assert.deepEqual(
    anthropic.accounts.map((a) => [a.provider, a.login]),
    [
      ["anthropic", "pi"],
      ["anthropic-2", "pi"],
      ["anthropic-3", "router"],
    ],
  );
  assert.equal(anthropic.accounts[1].usage?.windows[0].usedPercent, 100);
  assert.equal(anthropic.policy.strategy, "threshold");
  assert.equal(anthropic.policy.switchAt, 85);
  assert.deepEqual(anthropic.policy.fallback, [{ model: "openai-codex/gpt-5.5", thinking: "high" }]);
  const codex = state.providers.find((p) => p.base === "openai-codex")!;
  assert.deepEqual(codex.accounts.map((a) => [a.provider, a.login]), [["openai-codex", "pi"], ["openai-codex-2", "missing"]]);
  assert.deepEqual(codex.policy, DEFAULT_POLICY);
  assert.deepEqual(state.profiles[0].chain, [{ model: "anthropic/claude-opus-5-5", account: 2 }, { model: "openai-codex/gpt-5.5" }]);
  assert.equal(JSON.stringify(state).includes("secret"), false, "no token leaves the server");
});

test("entries, policies, and versions read as the extension reads them", () => {
  assert.deepEqual(readEntry({ model: "openai-codex-4/gpt" }), { model: "openai-codex/gpt", account: 4 });
  assert.deepEqual(readEntry({ model: "anthropic/x", account: 2, thinking: "low" }), { model: "anthropic/x", account: 2, thinking: "low" });
  assert.equal(readEntry({ model: "nope" }), null);
  assert.deepEqual(readPolicy({ strategy: "nonsense", switchAt: 400 }), DEFAULT_POLICY);
  assert.deepEqual(policyJson(DEFAULT_POLICY), { strategy: "balance" });
  assert.deepEqual(parseAccountProvider("anthropic-12"), { base: "anthropic", slot: 12 });
  assert.equal(parseAccountProvider("anthropic-1"), null);
  assert.equal(newerThan("0.12.11", [0, 12, 11]), false);
  assert.equal(newerThan("0.13.0", [0, 12, 11]), true);
  assert.equal(newerThan(null, [0, 12, 11]), false);
});

test("saving a policy and profiles keeps the rest of the file", async () => {
  await saveRouterPolicy({ provider: "openai-codex", policy: { ...DEFAULT_POLICY, strategy: "fill", useResets: "when-all-full" } });
  await saveRouterProfiles({
    profiles: [{ id: "fast", name: "Fast", strategy: "ordered", chain: [{ model: "anthropic/claude-haiku-5-5", account: 3 }], exhaustionPolicy: "fail", maxWaitMinutes: null }],
    autoSwitchOn429: false,
  });
  const written = JSON.parse(readFileSync(path.join(agentDir, "ext", "subscription-router.json"), "utf8"));
  assert.deepEqual(written.accounts["openai-codex"], { strategy: "fill", useResets: "when-all-full" });
  assert.equal(written.accounts.anthropic.strategy, "threshold");
  assert.deepEqual(written.profiles, { fast: { name: "Fast", chain: [{ model: "anthropic/claude-haiku-5-5", account: 3 }], exhaustionPolicy: "fail" } });
  assert.equal(written.autoSwitchOn429, false);
  assert.deepEqual(written.somethingElse, { kept: true });
  await assert.rejects(
    saveRouterPolicy({ provider: "anthropic", policy: { ...DEFAULT_POLICY, fallback: [{ model: "anthropic/x" }] } }),
    /model of anthropic itself/,
  );
  await assert.rejects(
    saveRouterProfiles({ profiles: [{ id: "x", name: "X", strategy: "ordered", chain: [{ model: "router/main" }], exhaustionPolicy: null, maxWaitMinutes: null }] }),
    /router model/,
  );
});

test("/router commands answer with their JSON, and errors come back as failures", async () => {
  const started = await runRouter({ action: "login-start", provider: "anthropic" });
  assert.equal(started.ok, true);
  assert.deepEqual((started.data as { provider: string }).provider, "anthropic-3");
  const failed = await runRouter({ action: "login-finish", id: "ab12", pasted: "bad#code" });
  assert.deepEqual([failed.ok, failed.output], [false, "State mismatch"]);
  const removed = await runRouter({ action: "remove", provider: "anthropic-3" });
  assert.deepEqual(removed.data, { removed: true, provider: "anthropic-3" });
  await assert.rejects(runRouter({ action: "login-finish", id: "ab12", pasted: "has spaces" }), /without spaces/);
  await assert.rejects(runRouter({ action: "resets-use" }), /Name the account/);
});
