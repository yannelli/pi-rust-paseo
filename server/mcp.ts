// MCP servers through `pi mcp`: the list with each server's state, on and off in the mcp.json pi
// reads the value from (crates/pi-mcp/src/config/files.rs), adds, removes, and OAuth sign-ins.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { CommandResult } from "../shared/contracts";
import {
  parsePairs,
  type McpLogin,
  type McpLoginState,
  type mcpAddRpc,
  type mcpListRpc,
  type mcpLoginRedirectRpc,
  type mcpLogoutRpc,
  type mcpRemoveRpc,
  type mcpToggleRpc,
} from "../shared/mcp";
import { prettyJson, readText, writeAtomic } from "./fsutil";
import { agentDir, piCommand, piEnv, piJson, requirePi, stripAnsi } from "./pi";
import { savedTrust } from "./trust";

type Raw = Record<string, unknown>;

const object = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);

/** pi runs `mcp` commands in the workspace; without one, in a directory with no project files. */
function runCwd(cwd: string | undefined): string {
  return cwd || tmpdir();
}

export function globalMcpConfig(): string {
  return path.join(agentDir(), "mcp.json");
}

/** The main checkout's directory for `cwd` in a linked git worktree, as pi finds it. */
function mainCheckoutDir(cwd: string): string | null {
  let root = path.resolve(cwd);
  while (!existsSync(path.join(root, ".git"))) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  try {
    const text = readFileSync(path.join(root, ".git"), "utf8").trim();
    if (!text.startsWith("gitdir:")) return null;
    const gitDir = path.resolve(root, text.slice("gitdir:".length).trim());
    const common = realpathSync(path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim()));
    if (path.basename(common) !== ".git") return null;
    return path.join(path.dirname(common), path.relative(root, path.resolve(cwd)));
  } catch {
    return null;
  }
}

/** `<cwd>/.pi/mcp.json`, or in a linked worktree without one, the main checkout's when it exists. */
export function projectMcpConfig(cwd: string): string {
  const local = path.join(cwd, ".pi", "mcp.json");
  if (existsSync(local)) return local;
  const main = mainCheckoutDir(cwd);
  const shared = main ? path.join(main, ".pi", "mcp.json") : null;
  return shared && existsSync(shared) ? shared : local;
}

/** pi's `mcp` commands read the project file only when a saved decision trusts the workspace. */
function mcpTrusted(cwd: string | undefined): boolean {
  return Boolean(cwd) && savedTrust(cwd!) === true;
}

interface ConfigEntry {
  scope: "global" | "project";
  source: string;
  overridePath: string | null;
  config: Raw;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure", "lifecycle"];

function isOverride(server: Raw): boolean {
  return !("command" in server) && !("url" in server) && !("type" in server);
}

async function readServers(file: string): Promise<Raw | null> {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return object(object(JSON.parse(text.replace(/^\uFEFF/, "")))?.mcpServers);
  } catch {
    return null;
  }
}

/** The servers of the global and (when trusted) project mcp.json, merged as pi merges them. */
async function loadConfig(cwd: string | undefined): Promise<Map<string, ConfigEntry>> {
  const entries = new Map<string, ConfigEntry>();
  const global = globalMcpConfig();
  for (const [name, value] of Object.entries((await readServers(global)) ?? {})) {
    const config = object(value);
    if (config) entries.set(name, { scope: "global", source: global, overridePath: null, config });
  }
  if (!mcpTrusted(cwd)) return entries;
  const project = projectMcpConfig(cwd!);
  for (const [name, value] of Object.entries((await readServers(project)) ?? {})) {
    const config = object(value);
    if (!config) continue;
    const base = entries.get(name);
    if (isOverride(config)) {
      if (base && Object.keys(config).every((key) => OVERRIDE_KEYS.includes(key))) {
        entries.set(name, { ...base, overridePath: project, config: { ...base.config, ...config } });
      }
      continue;
    }
    entries.set(name, { scope: "project", source: project, overridePath: null, config });
  }
  return entries;
}

function usesOAuth(config: Raw): boolean {
  if (typeof config.url !== "string" || config.auth !== undefined) return false;
  return !Object.keys(object(config.headers) ?? {}).some((header) => header.toLowerCase() === "authorization");
}

interface ReportedServer {
  name: string;
  scope: string;
  source: string;
  override?: string;
  enabled: boolean;
  exposure: string;
  transport: string;
  state: string;
  tools?: string[];
  toolExposure?: Record<string, string>;
  resources?: boolean;
  error?: string;
}

/** `pi mcp list --json` in the workspace. It exits 1 when a server fails, with the JSON still on stdout. */
export async function listMcp({ cwd }: RpcInput<typeof mcpListRpc>): Promise<RpcOutput<typeof mcpListRpc>> {
  const [report, config] = await Promise.all([
    piJson<{ servers?: ReportedServer[]; errors?: string[]; note?: string }>(["mcp", "list", "--json"], { cwd: runCwd(cwd), timeoutMs: 90_000 }),
    loadConfig(cwd),
  ]);
  const trusted = mcpTrusted(cwd);
  return {
    servers: (report.servers ?? []).map((server) => {
      const entry = config.get(server.name);
      return {
        name: server.name,
        scope: server.scope,
        source: server.source,
        override: server.override ?? null,
        enabled: server.enabled,
        exposure: server.exposure,
        transport: server.transport,
        state: server.state,
        tools: server.tools ?? [],
        toolExposure: server.toolExposure ?? null,
        resources: server.resources === true,
        error: server.error ?? null,
        oauth: entry ? usesOAuth(entry.config) : false,
      };
    }),
    errors: report.errors ?? [],
    note: report.note ?? null,
    trusted,
    globalConfig: globalMcpConfig(),
    projectConfig: cwd && trusted ? projectMcpConfig(cwd) : null,
  };
}

/** Reads an mcp.json, lets `edit` change its `mcpServers`, and writes it back in its indentation. */
async function editServers(file: string, edit: (servers: Raw) => void): Promise<void> {
  const text = (await readText(file))?.replace(/^\uFEFF/, "") ?? null;
  let root: Raw | null;
  try {
    root = text === null ? {} : object(JSON.parse(text));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}. Fix the file first.`);
  }
  if (!root || (root.mcpServers !== undefined && !object(root.mcpServers))) {
    throw new Error(`${file}: expected an object with an "mcpServers" object.`);
  }
  root.mcpServers ??= {};
  edit(root.mcpServers as Raw);
  const indent = text?.split("\n").find((line) => /^[ \t]+\S/.test(line))?.match(/^[ \t]+/)?.[0] ?? "  ";
  await writeAtomic(file, indent === "  " ? prettyJson(root) : `${JSON.stringify(root, null, indent)}\n`);
}

/**
 * Turns a server on or off where pi reads `enabled`: a project override when there is one, else
 * the file that defines the server. `enabled: true` is the default and removes the key, except in
 * an override, where it replaces the global value.
 */
export async function toggleMcp({ cwd, name, enabled }: RpcInput<typeof mcpToggleRpc>): Promise<RpcOutput<typeof mcpToggleRpc>> {
  const entry = (await loadConfig(cwd)).get(name);
  if (!entry) throw new Error(`No MCP server named "${name}" in ${globalMcpConfig()}${cwd ? " or the workspace's .pi/mcp.json" : ""}. Refresh the list.`);
  const file = entry.overridePath ?? entry.source;
  await editServers(file, (servers) => {
    const server = object(servers[name]);
    if (!server) throw new Error(`${file} does not define MCP server "${name}". Refresh the list.`);
    if (enabled && !isOverride(server)) delete server.enabled;
    else server.enabled = enabled;
  });
  return { path: file };
}

/** The arguments of `pi mcp add`; throws on a bad URL, command, or KEY=VALUE line. */
export function addArgs(input: RpcInput<typeof mcpAddRpc>): string[] {
  const args = ["mcp", "add"];
  if (input.scope === "project") args.push("--local");
  const command: string[] = [];
  if (input.transport === "http") {
    const url = (input.url ?? "").trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      // Reported below.
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error("Enter an http or https URL.");
    const headers = parsePairs(input.headers ?? "", "header");
    if (headers.error) throw new Error(`Headers: ${headers.error}`);
    args.push("--url", url);
    for (const [key, value] of headers.pairs) args.push("--header", `${key}=${value}`);
  } else {
    const program = (input.command ?? "").trim();
    if (!program) throw new Error("Enter the command that starts the server.");
    const env = parsePairs(input.env ?? "", "environment variable");
    if (env.error) throw new Error(`Environment: ${env.error}`);
    for (const [key, value] of env.pairs) args.push("--env", `${key}=${value}`);
    command.push(program, ...(input.args ?? []).filter((arg) => arg !== ""));
  }
  if (input.exposure && input.exposure !== "codemode") args.push("--exposure", input.exposure);
  // After `--` every word is positional, so names and commands that start with `-` stay intact.
  args.push("--", input.name, ...command);
  return args;
}

export async function addMcp(input: RpcInput<typeof mcpAddRpc>): Promise<CommandResult> {
  if (input.scope === "project" && !input.cwd) throw new Error("Choose a workspace to add a server to its .pi/mcp.json.");
  return piCommand(addArgs(input), { cwd: runCwd(input.cwd), timeoutMs: 30_000 });
}

export function removeArgs(scope: "global" | "project", name: string): string[] {
  return ["mcp", "remove", ...(scope === "project" ? ["--local"] : []), "--", name];
}

export async function removeMcp({ cwd, scope, name }: RpcInput<typeof mcpRemoveRpc>): Promise<CommandResult> {
  if (scope === "project" && !cwd) throw new Error("Choose the workspace whose .pi/mcp.json defines the server.");
  return piCommand(removeArgs(scope, name), { cwd: runCwd(cwd), timeoutMs: 30_000 });
}

export async function logoutMcp({ cwd, name }: RpcInput<typeof mcpLogoutRpc>): Promise<CommandResult> {
  return piCommand(["mcp", "logout", "--", name], { cwd: runCwd(cwd), timeoutMs: 60_000 });
}

// Sign-in sessions ------------------------------------------------------------------------------

/** pi's own limit for the whole sign-in, in seconds; the plugin kills it a little later. */
export const LOGIN_TIMEOUT_SECONDS = 300;
const KEEP_FINISHED_MS = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024;

interface LoginSession extends McpLogin {
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  endedAt: number | null;
}

const sessions = new Map<string, LoginSession>();

/** The authorization URL in `pi mcp login` output: the line after `Sign in to MCP server …`. */
export function parseLoginUrl(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const header = lines.findIndex((line) => line.startsWith("Sign in to MCP server"));
  if (header < 0) return null;
  const url = lines.slice(header + 1).find(Boolean);
  return url && /^https?:\/\/\S+$/.test(url) ? url : null;
}

function view(session: LoginSession): McpLogin {
  const { id, name, state, url, message, output } = session;
  return { id, name, state, url, message, output };
}

function finish(session: LoginSession, state: McpLoginState, message: string | null): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.endedAt ??= Date.now();
  if (session.state === "cancelled" || session.state === "done" || session.state === "failed") return;
  session.state = state;
  session.message = message;
}

function kill(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000).unref();
}

function forgetOld(): void {
  for (const [id, session] of sessions) {
    if (session.endedAt !== null && Date.now() - session.endedAt > KEEP_FINISHED_MS) sessions.delete(id);
  }
}

function lastLine(text: string): string | null {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? null;
}

/** Starts `pi mcp login <name>` and tracks it until it ends, fails, times out, or is cancelled. */
export function startLogin({ cwd, name }: { cwd?: string; name: string }, timeoutSeconds = LOGIN_TIMEOUT_SECONDS): McpLogin {
  forgetOld();
  const session: LoginSession = {
    id: randomBytes(8).toString("hex"),
    name,
    state: "starting",
    url: null,
    message: null,
    output: "",
    child: null,
    timer: null,
    endedAt: null,
  };
  sessions.set(session.id, session);
  const child = spawn(requirePi(), ["mcp", "login", "--timeout", String(timeoutSeconds), "--", name], {
    cwd: runCwd(cwd),
    env: piEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;
  let stderr = "";
  const collect = (chunk: string, isError: boolean) => {
    const text = stripAnsi(chunk);
    if (session.output.length < MAX_OUTPUT) session.output += text;
    if (isError) stderr += text;
    if (!session.url) {
      session.url = parseLoginUrl(session.output);
      if (session.url && session.state === "starting") session.state = "waiting";
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => collect(chunk, false));
  child.stderr?.on("data", (chunk: string) => collect(chunk, true));
  child.on("error", (error) => finish(session, "failed", error.message));
  child.on("close", (code) => {
    session.child = null;
    if (code === 0) finish(session, "done", lastLine(session.output));
    else finish(session, "failed", lastLine(stderr) ?? lastLine(session.output) ?? `pi exited with ${code ?? "a signal"}.`);
  });
  session.timer = setTimeout(() => {
    finish(session, "failed", `The sign-in did not finish within ${timeoutSeconds} seconds. Start it again.`);
    kill(child);
  }, (timeoutSeconds + 15) * 1000);
  session.timer.unref();
  return view(session);
}

function session(id: string): LoginSession {
  const found = sessions.get(id);
  if (!found) throw new Error("This sign-in has ended. Start it again.");
  return found;
}

export function loginStatus({ id }: { id: string }): McpLogin {
  return view(session(id));
}

export function cancelLogin({ id }: { id: string }): McpLogin {
  const found = session(id);
  finish(found, "cancelled", "Sign-in cancelled.");
  kill(found.child);
  return view(found);
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Checks a pasted redirect address and returns the URL to request on this machine. It must be an
 * http URL on a loopback host with a code or an error, on the port of the sign-in's redirect URI.
 */
export function checkRedirectUrl(pasted: string, authorizationUrl: string | null): URL {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error("Paste the full address from the browser's address bar, starting with http://.");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(`The address must start with http://127.0.0.1, http://localhost, or http://[::1]. This one goes to ${url.origin}.`);
  }
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
    throw new Error("The address has no sign-in code. Copy it from the page the browser opened after you signed in.");
  }
  const expected = redirectUri(authorizationUrl);
  if (expected && expected.port !== url.port) {
    throw new Error(`This address goes to port ${url.port || "80"}, but the sign-in waits on port ${expected.port || "80"}. Copy the address of this sign-in.`);
  }
  // pi serves `localhost` on 127.0.0.1 (crates/pi-mcp/src/runtime/signin.rs).
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function redirectUri(authorizationUrl: string | null): URL | null {
  if (!authorizationUrl) return null;
  try {
    const value = new URL(authorizationUrl).searchParams.get("redirect_uri");
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

/** Requests the pasted redirect address on this machine, so pi's loopback listener gets the code. */
export async function redirectLogin({ id, url }: RpcInput<typeof mcpLoginRedirectRpc>): Promise<McpLogin> {
  const found = session(id);
  if (found.state !== "waiting") throw new Error("This sign-in is not waiting for the browser anymore.");
  const target = checkRedirectUrl(url, found.url);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  let status: number;
  let body: string;
  try {
    const response = await fetch(target, { redirect: "manual", signal: abort.signal });
    status = response.status;
    body = (await response.text()).trim();
  } catch {
    throw new Error(`pi's sign-in listener at ${target.host} did not answer. The sign-in may have ended; start it again.`);
  } finally {
    clearTimeout(timer);
  }
  if (status < 200 || status >= 300) throw new Error(`pi did not accept the address: ${body || `HTTP ${status}`}`);
  return view(found);
}

/** Stops every sign-in, when the plugin stops. */
export function stopLogins(): void {
  for (const found of sessions.values()) {
    finish(found, "cancelled", "The plugin stopped.");
    kill(found.child);
  }
  sessions.clear();
}
