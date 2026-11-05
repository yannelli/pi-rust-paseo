// Finds pi and its agent directory, and runs pi commands for the plugin.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pluginSettings, type CommandResult, type PluginSettingsValues } from "../shared/contracts";

let settings: PluginSettingsValues = pluginSettings.schema.parse({});

export function currentSettings(): PluginSettingsValues {
  return settings;
}

export function applySettings(values: PluginSettingsValues): void {
  settings = values;
  resolvedPi = undefined;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

/** The plugin setting, else `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`, as pi resolves it. */
export function agentDir(): string {
  const configured = settings.agentDir.trim();
  if (configured) return path.resolve(expandHome(configured));
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return path.resolve(expandHome(env));
  return path.join(homedir(), ".pi", "agent");
}

/** `<cwd>/.pi`, the directory of project settings and project workflows. */
export function projectDir(cwd: string): string {
  return path.join(cwd, ".pi");
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first executable named `name` on PATH, or in the usual install directories. */
export function which(name: string, extraDirs: string[] = []): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of [...dirs, ...extraDirs]) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (executable(file)) return file;
    }
  }
  return null;
}

let resolvedPi: string | null | undefined;

/** The pi binary: the plugin setting, `$PI_BIN`, then `pi` on PATH or in `~/.local/bin` and `~/.cargo/bin`. */
export function piBinary(): string | null {
  if (resolvedPi !== undefined) return resolvedPi;
  const configured = settings.piPath.trim();
  if (configured) {
    resolvedPi = path.resolve(expandHome(configured));
    return resolvedPi;
  }
  const env = process.env.PI_BIN;
  if (env && executable(env)) {
    resolvedPi = env;
    return resolvedPi;
  }
  resolvedPi = which("pi", [path.join(homedir(), ".local", "bin"), path.join(homedir(), ".cargo", "bin")]);
  return resolvedPi;
}

export function requirePi(): string {
  const pi = piBinary();
  if (!pi) {
    throw new Error("pi was not found. Set its path in the plugin settings, or put pi on the daemon's PATH.");
  }
  return pi;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Environment for pi children: the daemon's, with the plugin's agent directory and no colors. */
export function piEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CLICOLOR: "0", ...extra };
  if (settings.agentDir.trim()) env.PI_CODING_AGENT_DIR = agentDir();
  delete env.FORCE_COLOR;
  return env;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs a program without a shell and collects its output. */
export function runProgram(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: piEnv(options.env),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        }, options.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut });
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export function runPi(args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runProgram(requirePi(), args, { timeoutMs: 120_000, ...options });
}

/** A pi command whose combined output the UI shows as is. */
export async function piCommand(args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const result = await runPi(args, options);
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
  const suffix = result.timedOut ? "\n(timed out)" : "";
  return { ok: result.code === 0 && !result.timedOut, code: result.code, output: output + suffix };
}

/** Runs pi and parses its stdout as JSON; the error names the command and its stderr. */
export async function piJson<T = unknown>(args: string[], options: RunOptions = {}): Promise<T> {
  const result = await runPi(args, options);
  const text = result.stdout.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const detail = (result.stderr.trim() || text).split("\n").slice(-5).join("\n");
    throw new Error(`pi ${args.join(" ")} failed${result.code !== null ? ` (exit ${result.code})` : ""}: ${detail}`);
  }
}

let versionCache: { pi: string; version: string | null } | undefined;

export async function piVersion(): Promise<string | null> {
  const pi = requirePi();
  if (versionCache?.pi === pi) return versionCache.version;
  const result = await runPi(["--version"], { timeoutMs: 15_000 });
  const version = result.stdout.trim().split(/\s+/).pop() ?? null;
  versionCache = { pi, version: result.code === 0 ? version : null };
  return versionCache.version;
}

export function forgetVersion(): void {
  versionCache = undefined;
}
