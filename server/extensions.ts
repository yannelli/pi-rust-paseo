// Using extensions from Paseo: their commands (run in a short-lived pi), their config files, and
// the rules of the `deferred` extension.
import { execFile } from "node:child_process";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  ExtensionCommand,
  extensionCommandRunRpc,
  extensionCommandsRpc,
  extensionConfigReadRpc,
  extensionConfigWriteRpc,
} from "../shared/contracts";
import { canonicalMode, DEFERRED_KINDS, type deferredConfigRpc, type deferredOptionsRpc, type deferredSetRpc, type Rule } from "../shared/deferred";
import { prettyJson, readJson, readText, writeAtomic } from "./fsutil";
import { readSettingsObject, settingsPath } from "./manage";
import { agentDir, projectDir } from "./pi";
import { withPiRpc } from "./rpc";
import { projectTrusted } from "./trust";

// Commands --------------------------------------------------------------------------------------

/** One entry of pi's `get_commands`: an extension command, a prompt template, or a `skill:` command. */
export interface PiCommand {
  name?: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string; source?: string; scope?: string };
}

const commandCache = new Map<string, { at: number; commands: PiCommand[] }>();
const COMMAND_TTL_MS = 60_000;

/** pi's commands in `cwd`, from a short-lived pi, cached for a minute. */
export async function piCommands(cwd: string, refresh = false): Promise<PiCommand[]> {
  const cached = commandCache.get(cwd);
  if (!refresh && cached && Date.now() - cached.at < COMMAND_TTL_MS) return cached.commands;
  const response = await withPiRpc(cwd, (rpc) => rpc.request({ type: "get_commands" }));
  const commands = ((response.data as { commands?: unknown[] } | undefined)?.commands ?? []) as PiCommand[];
  commandCache.set(cwd, { at: Date.now(), commands });
  return commands;
}

/** Drops the cached command lists, after a change that adds or removes commands, skills, or prompts. */
export function forgetCommands(): void {
  commandCache.clear();
}

async function listCommands(cwd: string, refresh = false): Promise<ExtensionCommand[]> {
  return (await piCommands(cwd, refresh))
    .filter((command) => command.source === "extension" && command.name && command.sourceInfo?.path && !command.sourceInfo.path.startsWith("builtin:"))
    .map((command) => ({ name: command.name!, description: command.description ?? "", extension: command.sourceInfo!.path! }));
}

export async function extensionCommands({ cwd, refresh }: RpcInput<typeof extensionCommandsRpc>): Promise<RpcOutput<typeof extensionCommandsRpc>> {
  try {
    return { commands: await listCommands(cwd ?? process.cwd(), refresh), error: null };
  } catch (error) {
    return { commands: [], error: (error as Error).message };
  }
}

/** Notices pi sends while it shuts a session down; they are not the command's output. */
const SHUTDOWN_NOISE = /exited with signal|session_shutdown/;

/**
 * Runs `/<command> <args>` of an installed extension in a temporary pi session and returns what
 * the extension reported. A command that starts an agent turn is stopped: nobody watches this session.
 */
export async function runExtensionCommand({ cwd, command, args }: RpcInput<typeof extensionCommandRunRpc>): Promise<RpcOutput<typeof extensionCommandRunRpc>> {
  const dir = cwd ?? process.cwd();
  const known = await listCommands(dir);
  if (!known.some((entry) => entry.name === command)) throw new Error(`/${command} is not a command of an installed extension.`);
  return runSlash(dir, command, args);
}

/** Runs `/<command> <args>` in a temporary pi session in `cwd`; see `runExtensionCommand`. */
export function runSlash(cwd: string, command: string, args: string, timeoutMs?: number): Promise<RpcOutput<typeof extensionCommandRunRpc>> {
  return withPiRpc(
    cwd,
    async (rpc) => {
      // Extensions may notify or ask while pi starts; only what follows the command is its output.
      const firstNotice = rpc.notices.length;
      const dialogsBefore = rpc.dialogs;
      const response = await rpc.request({ type: "prompt", message: `/${command}${args.trim() ? ` ${args.trim()}` : ""}` });
      // A question of the command comes before pi answers it; later ones come from other
      // extensions reacting to the run, such as hooks asking to run.
      const neededUi = rpc.dialogs > dialogsBefore;
      const data = (response.data ?? {}) as { disposition?: string; agentInvoked?: boolean };
      if (data.agentInvoked) await rpc.request({ type: "abort" });
      // Extensions may notify just after pi answers; give them a moment.
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (response.success === false) {
        return { disposition: "error", agentInvoked: false, output: [{ level: "error", text: String(response.error ?? "pi refused the command") }], neededUi };
      }
      return {
        disposition: data.disposition ?? "handled",
        agentInvoked: Boolean(data.agentInvoked),
        output: rpc.notices.slice(firstNotice).filter((notice) => !SHUTDOWN_NOISE.test(notice.text)),
        neededUi,
      };
    },
    timeoutMs,
  );
}

// Config files ----------------------------------------------------------------------------------

function configPath(name: string, scope: "global" | "project", cwd?: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Invalid extension name ${name}.`);
  if (scope === "global") return path.join(agentDir(), "ext", `${name}.json`);
  if (!cwd) throw new Error("A workspace config needs a working directory.");
  return path.join(projectDir(cwd), "ext", `${name}.json`);
}

export async function readExtensionConfig({ name, cwd }: RpcInput<typeof extensionConfigReadRpc>): Promise<RpcOutput<typeof extensionConfigReadRpc>> {
  const files = [];
  for (const scope of cwd ? (["global", "project"] as const) : (["global"] as const)) {
    const file = configPath(name, scope, cwd);
    const text = await readText(file);
    files.push({ scope, path: file, exists: text !== null, text: text ?? "{}\n" });
  }
  return { files };
}

export async function writeExtensionConfig({ name, scope, cwd, text }: RpcInput<typeof extensionConfigWriteRpc>): Promise<RpcOutput<typeof extensionConfigWriteRpc>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The config is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The config must be a JSON object.");
  if (scope === "project" && cwd && !projectTrusted(cwd)) throw new Error("pi does not trust this workspace, so it would ignore this file.");
  const file = configPath(name, scope, cwd);
  await writeAtomic(file, prettyJson(value));
  return { path: file };
}

// Deferred ----------------------------------------------------------------------------------------

type Block = Partial<Record<(typeof DEFERRED_KINDS)[number], Record<string, unknown>>> & {
  repos?: Record<string, Block>;
  auto?: unknown;
  maxResults?: unknown;
};

function asBlock(value: unknown): Block {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Block) : {};
}

/** `owner/name` of the `origin` remote, from https, ssh, git, and scp-style URLs. */
export function repoFromRemote(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function originRepo(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : repoFromRemote(stdout));
    });
  });
}

function rulesOf(block: Block, scope: Rule["scope"], origin: Rule["origin"], applies: boolean, repo: string | null, warnings: string[], label: string): Rule[] {
  const rules: Rule[] = [];
  for (const kind of DEFERRED_KINDS) {
    for (const [pattern, value] of Object.entries(asBlock(block[kind]) as Record<string, unknown>)) {
      const mode = canonicalMode(value);
      if (!mode) {
        warnings.push(`${label}: ${kind} ${pattern} has an unknown mode ${JSON.stringify(value)}`);
        continue;
      }
      rules.push({ kind, pattern, mode, scope, repo, origin, applies });
    }
  }
  return rules;
}

function repoBlocks(block: Block): [string, Block][] {
  return Object.entries(asBlock(block.repos) as Record<string, Block>).map(([key, value]) => [key, asBlock(value)]);
}

function repoApplies(pattern: string, repo: string | null): boolean {
  if (!repo) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(repo);
}

export async function deferredConfig({ cwd }: RpcInput<typeof deferredConfigRpc>): Promise<RpcOutput<typeof deferredConfigRpc>> {
  const warnings: string[] = [];
  const trusted = cwd ? projectTrusted(cwd) : false;
  const repo = cwd ? await originRepo(cwd) : null;
  const globalFile = path.join(agentDir(), "ext", "deferred.json");
  const projectFile = cwd ? path.join(projectDir(cwd), "ext", "deferred.json") : null;
  const read = async (file: string, label: string) => {
    try {
      return asBlock(await readJson(file));
    } catch (error) {
      warnings.push(`${label}: ${(error as Error).message}`);
      return {};
    }
  };
  const fileBlock = await read(globalFile, "ext/deferred.json");
  const settingsOf = (scope: "global" | "project") => readSettingsObject(scope, cwd).catch((): Record<string, unknown> => ({}));
  const globalSetting = asBlock((await settingsOf("global")).deferred);
  const projectSetting: Block = cwd ? asBlock((await settingsOf("project")).deferred) : {};
  const projectBlock = projectFile ? await read(projectFile, ".pi/ext/deferred.json") : {};

  // The order the extension applies them in; later rules win.
  const rules: Rule[] = [
    ...rulesOf(fileBlock, "global", "file", true, null, warnings, "ext/deferred.json"),
    ...rulesOf(globalSetting, "global", "settings", true, null, warnings, "settings.json"),
  ];
  for (const [source, origin] of [
    [fileBlock, "file"],
    [globalSetting, "settings"],
  ] as const) {
    for (const [key, block] of repoBlocks(source)) {
      rules.push(...rulesOf(block, "repo", origin, repoApplies(key, repo), key, warnings, `repos.${key}`));
    }
  }
  if (cwd) {
    rules.push(...rulesOf(projectSetting, "project", "settings", trusted, null, warnings, ".pi/settings.json"));
    rules.push(...rulesOf(projectBlock, "project", "file", trusted, null, warnings, ".pi/ext/deferred.json"));
  }

  const pick = <T>(key: "auto" | "maxResults", fallback: T): unknown => {
    let value: unknown = fallback;
    for (const block of [fileBlock, globalSetting, ...(cwd && trusted ? [projectSetting, projectBlock] : [])]) {
      if (block[key] !== undefined) value = block[key];
    }
    return value;
  };
  const autoValue = pick("auto", 10);
  const maxValue = pick("maxResults", 5);
  const settingsFile = settingsPath("global");
  const sources = [
    { label: "ext/deferred.json", path: globalFile, exists: (await readText(globalFile)) !== null, editable: false },
    { label: "Global settings", path: settingsFile, exists: true, editable: true },
  ];
  if (cwd && projectFile) {
    sources.push({ label: "Workspace settings", path: settingsPath("project", cwd), exists: (await readText(settingsPath("project", cwd))) !== null, editable: trusted });
    sources.push({ label: "Workspace ext/deferred.json", path: projectFile, exists: (await readText(projectFile)) !== null, editable: false });
  }
  return {
    rules,
    auto: autoValue === false || autoValue === 0 ? false : typeof autoValue === "number" ? autoValue : 10,
    maxResults: typeof maxValue === "number" ? Math.min(50, Math.max(1, maxValue)) : 5,
    repo,
    trusted,
    sources,
    warnings,
  };
}

/** Writes or removes one rule in the `deferred` setting, as `/deferred set` and `unset` do. */
export async function deferredSet({ cwd, scope, repo, kind, pattern, mode }: RpcInput<typeof deferredSetRpc>): Promise<RpcOutput<typeof deferredSetRpc>> {
  if (mode === "user" && kind !== "skills") throw new Error("Only skills have the user mode.");
  if (scope === "project") {
    if (!cwd) throw new Error("A workspace rule needs a working directory.");
    if (!projectTrusted(cwd)) throw new Error("pi does not trust this workspace, so it would ignore its rules.");
  }
  const target = scope === "project" ? "project" : "global";
  const settings = await readSettingsObject(target, cwd);
  const deferred = asBlock(settings.deferred);
  let block: Block = deferred;
  if (scope === "repo") {
    const name = repo ?? (cwd ? await originRepo(cwd) : null);
    if (!name) throw new Error("Name a repository as owner/name.");
    deferred.repos = asBlock(deferred.repos) as Record<string, Block>;
    deferred.repos[name] = asBlock(deferred.repos[name]);
    block = deferred.repos[name];
  }
  const rules = asBlock(block[kind]) as Record<string, unknown>;
  if (mode === null) delete rules[pattern];
  else rules[pattern] = mode;
  if (Object.keys(rules).length) block[kind] = rules;
  else delete block[kind];
  if (scope === "repo" && deferred.repos) {
    for (const [key, value] of Object.entries(deferred.repos)) if (Object.keys(asBlock(value)).length === 0) delete deferred.repos[key];
    if (Object.keys(deferred.repos).length === 0) delete deferred.repos;
  }
  if (Object.keys(deferred).length) settings.deferred = deferred;
  else delete settings.deferred;
  const file = settingsPath(target, cwd);
  await writeAtomic(file, prettyJson(settings));
  return { path: file };
}

export async function deferredOptions({ auto, maxResults }: RpcInput<typeof deferredOptionsRpc>): Promise<RpcOutput<typeof deferredOptionsRpc>> {
  const settings = await readSettingsObject("global");
  const deferred = asBlock(settings.deferred);
  deferred.auto = auto;
  deferred.maxResults = maxResults;
  settings.deferred = deferred;
  const file = settingsPath("global");
  await writeAtomic(file, prettyJson(settings));
  return { path: file };
}
