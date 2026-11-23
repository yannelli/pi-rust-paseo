// MCP servers through a fake pi: the list, on and off in mcp.json, add and remove arguments, and
// OAuth sign-in sessions with a pasted redirect address.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pluginSettings } from "../shared/contracts";
import { parsePairs } from "../shared/mcp";
import { applySettings } from "../server/pi";
import {
  addArgs,
  cancelLogin,
  checkRedirectUrl,
  listMcp,
  loginStatus,
  parseLoginUrl,
  redirectLogin,
  removeArgs,
  startLogin,
  stopLogins,
  toggleMcp,
} from "../server/mcp";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-rust-mcp-")));
const agentDir = path.join(root, "agent");
const project = path.join(root, "project");
const fakePi = path.join(root, "pi");

// `mcp list` prints $FAKE_LIST and exits with $FAKE_CODE. `mcp login` follows $FAKE_LOGIN:
// `listen` prints a URL and waits for the callback on a loopback port, `hang` prints one, writes
// its pid to $FAKE_PID_FILE, and waits; `fail` exits 1. Other commands print their arguments.
const FAKE_PI = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[1] === "list") {
  process.stdout.write(process.env.FAKE_LIST ?? "");
  process.exit(Number(process.env.FAKE_CODE ?? 0));
}
if (args[1] === "login") {
  const mode = process.env.FAKE_LOGIN;
  const name = args[args.length - 1];
  if (mode === "fail") {
    console.error('MCP server "' + name + '" does not use OAuth. Only HTTP servers without an Authorization header do.');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== "s1") {
      res.writeHead(400, { Connection: "close" });
      res.end("Invalid or expired OAuth state");
      return;
    }
    res.writeHead(200, { Connection: "close" });
    res.end("Authorization complete. You may close this window.");
    console.log('Signed in to MCP server "' + name + '" (2 tools).');
    server.close(() => process.exit(0));
  });
  server.listen(0, "127.0.0.1", () => {
    const redirect = "http://localhost:" + server.address().port + "/callback";
    console.log('Sign in to MCP server "' + name + '" in your browser:');
    console.log("https://auth.example.com/authorize?state=s1&redirect_uri=" + encodeURIComponent(redirect));
    if (mode === "hang") {
      server.close();
      require("node:fs").writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    }
  });
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify(args));
}
`;

function writeJson(file: string, value: unknown, indent: number | string = 2): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, indent)}\n`);
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const globalFile = path.join(agentDir, "mcp.json");
const projectFile = path.join(project, ".pi", "mcp.json");

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

before(() => {
  mkdirSync(project, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  applySettings({ ...pluginSettings.schema.parse({}), agentDir, piPath: fakePi });
});

after(() => stopLogins());

function setConfig(trusted: boolean): void {
  writeJson(globalFile, {
    autoEnableCodemode: true,
    mcpServers: {
      docs: { url: "https://docs.example.com/mcp", exposure: "direct" },
      github: { url: "https://api.github.com/mcp", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
      files: { command: "npx", args: ["-y", "files-mcp"], enabled: false },
    },
  }, 4);
  writeJson(projectFile, { mcpServers: { docs: { enabled: false }, local: { command: "./bin/mcp" } } });
  writeJson(path.join(agentDir, "trust.json"), trusted ? { [project]: true } : {});
}

test("the list keeps pi's report when pi exits 1, and adds OAuth and trust", async () => {
  setConfig(true);
  process.env.FAKE_CODE = "1";
  process.env.FAKE_LIST = JSON.stringify({
    servers: [
      { name: "docs", scope: "global", source: globalFile, override: projectFile, enabled: false, exposure: "direct", transport: "https://docs.example.com/mcp", state: "disabled", tools: [] },
      { name: "github", scope: "global", source: globalFile, enabled: true, exposure: "codemode", transport: "https://api.github.com/mcp", state: "failed", tools: [], error: "HTTP 401" },
      { name: "local", scope: "project", source: projectFile, enabled: true, exposure: "codemode", transport: "./bin/mcp", state: "connected", tools: ["a", "b"], toolExposure: { b: "hidden" }, resources: true },
    ],
    errors: [`${globalFile}: server "bad" needs either "command" (stdio) or "url" (streamable HTTP)`],
  });
  const list = await listMcp({ cwd: project });
  assert.deepEqual(list.servers.map((s) => [s.name, s.state, s.oauth, s.override]), [
    ["docs", "disabled", true, projectFile],
    ["github", "failed", false, null],
    ["local", "connected", false, null],
  ]);
  assert.equal(list.servers[1].error, "HTTP 401");
  assert.deepEqual(list.servers[2].toolExposure, { b: "hidden" });
  assert.equal(list.servers[2].resources, true);
  assert.equal(list.errors.length, 1);
  assert.equal(list.trusted, true);
  assert.equal(list.projectConfig, projectFile);

  process.env.FAKE_LIST = "error: something broke";
  await assert.rejects(listMcp({ cwd: project }), /pi mcp list --json failed \(exit 1\)/);
});

test("on and off edit the file pi reads the value from, keeping the rest", async () => {
  setConfig(true);
  // A global server: off sets `enabled: false`, on removes the key; the 4-space indent stays.
  assert.deepEqual(await toggleMcp({ cwd: project, name: "files", enabled: true }), { path: globalFile });
  assert.deepEqual(readJson(globalFile).mcpServers.files, { command: "npx", args: ["-y", "files-mcp"] });
  assert.equal(readJson(globalFile).autoEnableCodemode, true);
  assert.match(readFileSync(globalFile, "utf8"), /^ {4}"mcpServers"/m);
  await toggleMcp({ cwd: project, name: "github", enabled: false });
  assert.equal(readJson(globalFile).mcpServers.github.enabled, false);
  // An override in the trusted project decides, and keeps `enabled: true`.
  assert.deepEqual(await toggleMcp({ cwd: project, name: "docs", enabled: true }), { path: projectFile });
  assert.deepEqual(readJson(projectFile).mcpServers.docs, { enabled: true });
  assert.equal(readJson(globalFile).mcpServers.docs.enabled, undefined);
  // A project server is edited in the project file.
  await toggleMcp({ cwd: project, name: "local", enabled: false });
  assert.deepEqual(readJson(projectFile).mcpServers.local, { command: "./bin/mcp", enabled: false });
  assert.equal(readFileSync(projectFile, "utf8").endsWith("}\n"), true);

  // Without trust, pi ignores the project file: the global entry changes, and project servers are unknown.
  setConfig(false);
  assert.deepEqual(await toggleMcp({ cwd: project, name: "docs", enabled: false }), { path: globalFile });
  assert.deepEqual(readJson(projectFile).mcpServers.docs, { enabled: false });
  await assert.rejects(toggleMcp({ cwd: project, name: "local", enabled: true }), /No MCP server named "local"/);
});

test("add and remove build pi's arguments and check KEY=VALUE lines", () => {
  const base = { cwd: project, name: "docs", url: "", command: "", args: [], env: "", headers: "", exposure: "codemode" as const };
  assert.deepEqual(
    addArgs({ ...base, scope: "project", transport: "http", url: " https://docs.example.com/mcp ", headers: "Authorization=Bearer ${TOKEN}\n\nX-Team = core\n", exposure: "deferred" }),
    ["mcp", "add", "--local", "--url", "https://docs.example.com/mcp", "--header", "Authorization=Bearer ${TOKEN}", "--header", "X-Team=core", "--exposure", "deferred", "--", "docs"],
  );
  assert.deepEqual(
    addArgs({ ...base, scope: "global", transport: "stdio", command: "npx", args: ["-y", "--port=1", ""], env: "API_KEY=a=b" }),
    ["mcp", "add", "--env", "API_KEY=a=b", "--", "docs", "npx", "-y", "--port=1"],
  );
  assert.throws(() => addArgs({ ...base, scope: "global", transport: "http", url: "ftp://x" }), /http or https URL/);
  assert.throws(() => addArgs({ ...base, scope: "global", transport: "stdio", command: " " }), /Enter the command/);
  assert.throws(() => addArgs({ ...base, scope: "global", transport: "stdio", command: "x", env: "OK=1\nnot a pair" }), /Environment: Line 2 is not KEY=VALUE/);
  assert.deepEqual(parsePairs("1BAD=x", "environment variable").error, 'Line 1: "1BAD" is not a valid environment variable name.');
  assert.deepEqual(removeArgs("project", "-odd"), ["mcp", "remove", "--local", "--", "-odd"]);
  assert.deepEqual(removeArgs("global", "docs"), ["mcp", "remove", "--", "docs"]);
});

test("the sign-in URL is the line after pi's prompt", () => {
  assert.equal(parseLoginUrl('Sign in to MCP server "docs" in your browser:\nhttps://auth.example.com/a?b=1\n'), "https://auth.example.com/a?b=1");
  assert.equal(parseLoginUrl('Sign in to MCP server "docs" in your browser:\n'), null);
  assert.equal(parseLoginUrl("Already signed in to MCP server \"docs\" (3 tools).\n"), null);
});

test("a pasted redirect address must be http on a loopback host, with a code, on the sign-in's port", () => {
  const auth = `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent("http://localhost:4321/callback")}`;
  assert.equal(checkRedirectUrl("http://localhost:4321/callback?code=c&state=s", auth).href, "http://127.0.0.1:4321/callback?code=c&state=s");
  assert.equal(checkRedirectUrl("http://[::1]:4321/callback?error=access_denied", auth).hostname, "[::1]");
  assert.throws(() => checkRedirectUrl("not a url", auth), /full address/);
  assert.throws(() => checkRedirectUrl("https://127.0.0.1:4321/callback?code=c", auth), /must start with http:\/\/127\.0\.0\.1/);
  assert.throws(() => checkRedirectUrl("http://evil.example.com:4321/callback?code=c", auth), /goes to http:\/\/evil\.example\.com:4321/);
  assert.throws(() => checkRedirectUrl("http://127.0.0.1:4321/callback", auth), /no sign-in code/);
  assert.throws(() => checkRedirectUrl("http://127.0.0.1:9999/callback?code=c", auth), /port 9999, but the sign-in waits on port 4321/);
});

test("a sign-in finishes when the pasted redirect address reaches pi's listener", async () => {
  setConfig(true);
  process.env.FAKE_LOGIN = "listen";
  const started = startLogin({ cwd: project, name: "docs" });
  assert.equal(started.state, "starting");
  await until(() => loginStatus({ id: started.id }).state === "waiting");
  const waiting = loginStatus({ id: started.id });
  const redirect = new URL(new URL(waiting.url!).searchParams.get("redirect_uri")!);
  await assert.rejects(redirectLogin({ id: started.id, url: `${redirect.origin}/callback?code=c&state=wrong` }), /pi did not accept the address: Invalid or expired OAuth state/);
  await redirectLogin({ id: started.id, url: `${redirect.origin}/callback?code=c&state=s1` });
  await until(() => loginStatus({ id: started.id }).state !== "waiting");
  assert.deepEqual(loginStatus({ id: started.id }).state, "done");
  assert.equal(loginStatus({ id: started.id }).message, 'Signed in to MCP server "docs" (2 tools).');
  await assert.rejects(redirectLogin({ id: started.id, url: `${redirect.origin}/callback?code=c&state=s1` }), /not waiting/);
});

test("a sign-in fails with pi's error, and cancel stops pi", async () => {
  process.env.FAKE_LOGIN = "fail";
  const failed = startLogin({ cwd: project, name: "github" });
  await until(() => loginStatus({ id: failed.id }).state !== "starting");
  assert.equal(loginStatus({ id: failed.id }).state, "failed");
  assert.match(loginStatus({ id: failed.id }).message ?? "", /does not use OAuth/);

  process.env.FAKE_LOGIN = "hang";
  process.env.FAKE_PID_FILE = path.join(root, "login.pid");
  const hanging = startLogin({ cwd: project, name: "docs" });
  await until(() => loginStatus({ id: hanging.id }).state === "waiting");
  const redirect = new URL(new URL(loginStatus({ id: hanging.id }).url!).searchParams.get("redirect_uri")!);
  await assert.rejects(redirectLogin({ id: hanging.id, url: `${redirect.origin}/callback?code=c&state=s1` }), /did not answer/);
  assert.equal(cancelLogin({ id: hanging.id }).state, "cancelled");
  const pid = Number(readFileSync(process.env.FAKE_PID_FILE, "utf8"));
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(loginStatus({ id: hanging.id }).state, "cancelled");
  assert.throws(() => loginStatus({ id: "0123456789abcdef" }), /has ended/);
});
