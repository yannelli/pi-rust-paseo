// pi itself and its extensions: version, doctor, updates, models, settings files, sessions,
// stats, usage, and installed or marketplace extensions.
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type {
  CommandResult,
  defaultsWriteRpc,
  doctorRpc,
  ExtensionAction,
  extensionsInfoRpc,
  extensionsListRpc,
  extensionsRunRpc,
  extensionsSearchRpc,
  ModelInfo,
  modelsRpc,
  ScopeName,
  sessionsListRpc,
  sessionsPruneRpc,
  sessionsRemoveRpc,
  settingsReadRpc,
  settingsWriteRpc,
  statsRpc,
  updateRpc,
  usageRpc,
} from "../shared/contracts";
import { prettyJson, readText, writeAtomic } from "./fsutil";
import { parseExtensionList, parseInfo, parseModels, parsePackageList, parseSearch } from "./parse";
import { agentDir, forgetVersion, piCommand, piJson, projectDir, runPi } from "./pi";

function requireCwd(scope: ScopeName, cwd: string | undefined): string | undefined {
  if (scope === "project" && !cwd) throw new Error("Project scope needs a working directory.");
  return cwd;
}

/** `-l` and `--approve` for project scope: choosing a project in Paseo trusts it for this command. */
function scopeFlags(scope: ScopeName): string[] {
  return scope === "project" ? ["-l", "--approve"] : [];
}

export function settingsPath(scope: ScopeName, cwd?: string): string {
  if (scope === "global") return path.join(agentDir(), "settings.json");
  const dir = requireCwd(scope, cwd);
  return path.join(projectDir(dir as string), "settings.json");
}

export async function readSettingsObject(scope: ScopeName, cwd?: string): Promise<Record<string, unknown>> {
  const text = await readText(settingsPath(scope, cwd));
  if (!text?.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json is not a JSON object");
  return value as Record<string, unknown>;
}

// Overview ----------------------------------------------------------------------------------

export async function doctor({ cwd }: RpcInput<typeof doctorRpc>): Promise<RpcOutput<typeof doctorRpc>> {
  try {
    const report = await piJson<Record<string, unknown>>(["doctor", "--json"], { cwd, timeoutMs: 60_000 });
    return { report, error: null };
  } catch (error) {
    return { report: null, error: (error as Error).message };
  }
}

export async function update({ target, force }: RpcInput<typeof updateRpc>): Promise<RpcOutput<typeof updateRpc>> {
  const flag = { self: "--self", extensions: "--extensions", models: "--models", all: "--all" }[target];
  const args = ["update", flag];
  if (force && (target === "self" || target === "all")) args.push("--force");
  const result = await piCommand(args, { timeoutMs: 600_000 });
  if (target === "self" || target === "all") forgetVersion();
  if (target === "models" || target === "all") modelCache = undefined;
  return result;
}

let modelCache: { at: number; models: ModelInfo[] } | undefined;
const MODEL_TTL_MS = 5 * 60_000;

export async function listModels(refresh = false): Promise<ModelInfo[]> {
  if (!refresh && modelCache && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  const result = await runPi(["--list-models"], { timeoutMs: 60_000, env: { PI_OFFLINE: "1" } });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `pi --list-models exited with ${result.code}`);
  const models = parseModels(result.stdout);
  modelCache = { at: Date.now(), models };
  return models;
}

export async function models({ refresh }: RpcInput<typeof modelsRpc>): Promise<RpcOutput<typeof modelsRpc>> {
  try {
    return { models: await listModels(refresh), error: null };
  } catch (error) {
    return { models: [], error: (error as Error).message };
  }
}

export async function readSettings({ scope, cwd }: RpcInput<typeof settingsReadRpc>): Promise<RpcOutput<typeof settingsReadRpc>> {
  const file = settingsPath(scope, cwd);
  const text = await readText(file);
  return { path: file, exists: text !== null, text: text ?? "{}\n" };
}

export async function writeSettings({ scope, cwd, text }: RpcInput<typeof settingsWriteRpc>): Promise<RpcOutput<typeof settingsWriteRpc>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`settings.json is not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json must be a JSON object");
  const file = settingsPath(scope, cwd);
  await writeAtomic(file, prettyJson(value));
  modelCache = undefined;
  return { path: file };
}

export async function writeDefaults(input: RpcInput<typeof defaultsWriteRpc>): Promise<RpcOutput<typeof defaultsWriteRpc>> {
  const file = settingsPath("global");
  const settings = await readSettingsObject("global");
  const keys = { provider: "defaultProvider", model: "defaultModel", thinking: "defaultThinkingLevel" } as const;
  for (const [field, key] of Object.entries(keys) as [keyof typeof keys, string][]) {
    const value = input[field];
    if (value === undefined) continue;
    if (value === null || value.trim() === "") delete settings[key];
    else settings[key] = value.trim();
  }
  await writeAtomic(file, prettyJson(settings));
  return { path: file };
}

// Sessions, stats, usage ---------------------------------------------------------------------

interface RawSession {
  id: string;
  shortId?: string;
  path: string;
  cwd?: string;
  name?: string | null;
  firstMessage?: string | null;
  created?: string | null;
  modified?: string | null;
  messageCount?: number;
  cost?: number;
}

export async function listSessions({ cwd, all, limit }: RpcInput<typeof sessionsListRpc>): Promise<RpcOutput<typeof sessionsListRpc>> {
  const args = ["sessions", "list", "--json"];
  if (all) args.push("--all");
  args.push("--limit", String(limit ?? 100));
  const raw = await piJson<RawSession[]>(args, { cwd, timeoutMs: 60_000 });
  return {
    sessions: raw.map((session) => ({
      id: session.id,
      shortId: session.shortId ?? session.id.slice(0, 10),
      path: session.path,
      cwd: session.cwd ?? "",
      name: session.name ?? null,
      firstMessage: (session.firstMessage ?? "").slice(0, 500),
      created: session.created ?? null,
      modified: session.modified ?? null,
      messageCount: session.messageCount ?? 0,
      cost: session.cost ?? 0,
    })),
  };
}

export function removeSessions({ cwd, all, ids }: RpcInput<typeof sessionsRemoveRpc>): Promise<CommandResult> {
  const args = ["sessions", "rm", ...ids, "--yes"];
  if (all) args.push("--all");
  return piCommand(args, { cwd, timeoutMs: 60_000 });
}

export function pruneSessions({ cwd, all, olderThan, dryRun }: RpcInput<typeof sessionsPruneRpc>): Promise<CommandResult> {
  const args = ["sessions", "prune", "--older-than", olderThan];
  if (dryRun) args.push("--dry-run");
  else args.push("--yes");
  if (all) args.push("--all");
  return piCommand(args, { cwd, timeoutMs: 120_000 });
}

export async function stats({ cwd, all }: RpcInput<typeof statsRpc>): Promise<RpcOutput<typeof statsRpc>> {
  try {
    const args = ["stats", "--json"];
    if (all) args.push("--all");
    return { report: await piJson<Record<string, unknown>>(args, { cwd, timeoutMs: 120_000 }), error: null };
  } catch (error) {
    return { report: null, error: (error as Error).message };
  }
}

export async function usage(_input: RpcInput<typeof usageRpc>): Promise<RpcOutput<typeof usageRpc>> {
  try {
    return { report: await piJson(["usage", "--json"], { timeoutMs: 60_000 }), error: null };
  } catch (error) {
    return { report: null, error: (error as Error).message };
  }
}

// Extensions --------------------------------------------------------------------------------

export async function listExtensions({ scope, cwd }: RpcInput<typeof extensionsListRpc>): Promise<RpcOutput<typeof extensionsListRpc>> {
  requireCwd(scope, cwd);
  const flags = scopeFlags(scope);
  const [extensions, packages] = await Promise.all([
    runPi(["extensions", "list", ...flags], { cwd, timeoutMs: 60_000, env: { PI_OFFLINE: "1" } }),
    runPi(["list", ...(scope === "project" ? ["--approve"] : [])], { cwd, timeoutMs: 60_000, env: { PI_OFFLINE: "1" } }),
  ]);
  if (extensions.code !== 0) throw new Error(extensions.stderr.trim() || "pi extensions list failed");
  return {
    extensions: parseExtensionList(extensions.stdout),
    packages: packages.code === 0 ? parsePackageList(packages.stdout) : [],
  };
}

export async function searchExtensions({ query }: RpcInput<typeof extensionsSearchRpc>): Promise<RpcOutput<typeof extensionsSearchRpc>> {
  const args = ["extensions", "search"];
  if (query.trim()) args.push(query.trim());
  const result = await runPi(args, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    return { results: [], error: (result.stderr.trim() || result.stdout.trim() || "search failed").split("\n").slice(-3).join("\n") };
  }
  return { results: parseSearch(result.stdout), error: null };
}

export async function extensionInfo({ name }: RpcInput<typeof extensionsInfoRpc>): Promise<RpcOutput<typeof extensionsInfoRpc>> {
  const result = await runPi(["extensions", "info", name], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `no extension ${name}`);
  return { ...parseInfo(result.stdout), text: result.stdout.trim() };
}

/** Runs `pi install|remove|update` or `pi extensions enable|disable` in the chosen scope. */
export function extensionCommand(action: ExtensionAction, target: string, scope: ScopeName, cwd?: string): Promise<CommandResult> {
  requireCwd(scope, cwd);
  const flags = scopeFlags(scope);
  const args: Record<ExtensionAction, string[]> = {
    install: ["install", target, ...flags],
    remove: ["remove", target, ...flags],
    enable: ["extensions", "enable", target, ...flags],
    disable: ["extensions", "disable", target, ...flags],
    update: ["update", "--extension", target, ...(scope === "project" ? ["--approve"] : [])],
  };
  return piCommand(args[action], { cwd, timeoutMs: action === "enable" || action === "disable" ? 60_000 : 600_000 });
}

export function runExtension({ action, target, scope, cwd }: RpcInput<typeof extensionsRunRpc>): Promise<RpcOutput<typeof extensionsRunRpc>> {
  return extensionCommand(action, target.trim(), scope, cwd);
}
