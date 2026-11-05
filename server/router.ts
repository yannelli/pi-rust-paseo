// Subscription accounts of the `subscription-router` extension: its files under
// `<agentDir>/ext/subscription-router`, its config file, and `/router` commands for logins,
// removals, usage refreshes, and Codex usage resets (which only the extension can do).
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  DEFAULT_POLICY,
  SUBSCRIPTION_PROVIDERS,
  accountProvider,
  parseAccountProvider,
  type Entry,
  type Policy,
  type Profile,
  type SubscriptionAccount,
  type Usage,
  type routerPolicySaveRpc,
  type routerProfilesSaveRpc,
  type routerRunRpc,
  type routerStateRpc,
} from "../shared/router";
import { forgetCommands, runSlash } from "./extensions";
import { exists, prettyJson, readJson, writeAtomic } from "./fsutil";
import { agentDir, piVersion } from "./pi";

/** The first pi-rust release with `before_provider_auth` comes after this one. */
const LAST_WITHOUT_ACCOUNTS = [0, 12, 11];

type Raw = Record<string, unknown>;

const object = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});

/** `$PI_ROUTER_CONFIG`, else `ext/subscription-router.json`, else the upstream file when only it exists. */
export async function routerConfigPath(write = false): Promise<string> {
  const env = process.env.PI_ROUTER_CONFIG;
  if (env) return env;
  const primary = path.join(agentDir(), "ext", "subscription-router.json");
  const legacy = path.join(agentDir(), "subscription-router.json");
  if (!write && !(await exists(primary)) && (await exists(legacy))) return legacy;
  return primary;
}

export function newerThan(version: string | null, than: number[]): boolean {
  if (!version) return false;
  const parts = version.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== than[index]) return parts[index] > than[index];
  }
  return false;
}

/** A chain or fallback entry from the file: `anthropic-2/x` is `anthropic/x` on account 2. */
export function readEntry(raw: unknown): Entry | null {
  const value = object(raw);
  if (typeof value.model !== "string" || !value.model.includes("/")) return null;
  const [provider, ...rest] = value.model.split("/");
  const id = rest.join("/");
  const parsed = parseAccountProvider(provider);
  const entry: Entry = { model: parsed ? `${parsed.base}/${id}` : value.model };
  const account = typeof value.account === "number" ? value.account : parsed && parsed.slot > 1 ? parsed.slot : undefined;
  if (account && account > 1) entry.account = account;
  if (typeof value.thinking === "string") entry.thinking = value.thinking as Entry["thinking"];
  return entry;
}

export function entryJson(entry: Entry): Raw {
  const out: Raw = { model: entry.model };
  if (entry.account && entry.account > 1) out.account = entry.account;
  if (entry.thinking) out.thinking = entry.thinking;
  return out;
}

export function readPolicy(raw: unknown): Policy {
  const value = object(raw);
  const pick = <K extends keyof Policy>(key: K, ok: (v: unknown) => boolean): Policy[K] => (ok(value[key]) ? (value[key] as Policy[K]) : DEFAULT_POLICY[key]);
  return {
    strategy: pick("strategy", (v) => typeof v === "string" && ["balance", "fill", "threshold", "manual"].includes(v)),
    account: pick("account", (v) => typeof v === "number"),
    switchAt: pick("switchAt", (v) => typeof v === "number" && v > 0 && v <= 100),
    fallback: Array.isArray(value.fallback) ? value.fallback.map(readEntry).filter((e): e is Entry => e !== null) : [],
    returnWhenAvailable: pick("returnWhenAvailable", (v) => typeof v === "boolean"),
    useResets: pick("useResets", (v) => typeof v === "string" && ["off", "when-full", "when-all-full"].includes(v)),
    resetMinWaitMinutes: pick("resetMinWaitMinutes", (v) => typeof v === "number" && v >= 0),
  };
}

/** The policy as the extension writes it: the strategy plus the keys that differ from defaults. */
export function policyJson(policy: Policy): Raw {
  const out: Raw = { strategy: policy.strategy };
  for (const key of ["account", "switchAt", "returnWhenAvailable", "useResets", "resetMinWaitMinutes"] as const) {
    if (policy[key] !== DEFAULT_POLICY[key]) out[key] = policy[key];
  }
  if (policy.fallback.length) out.fallback = policy.fallback.map(entryJson);
  return out;
}

export function readProfiles(raw: unknown): Profile[] {
  return Object.entries(object(raw)).map(([id, value]) => {
    const profile = object(value);
    const policy = profile.exhaustionPolicy;
    return {
      id,
      name: typeof profile.name === "string" ? profile.name : `Router ${id}`,
      strategy: profile.strategy === "balanced" ? "balanced" : "ordered",
      chain: Array.isArray(profile.chain) ? profile.chain.map(readEntry).filter((e): e is Entry => e !== null) : [],
      exhaustionPolicy: policy === "wait" || policy === "fail" ? policy : null,
      maxWaitMinutes: typeof profile.maxWaitMinutes === "number" ? profile.maxWaitMinutes : null,
    };
  });
}

export function profileJson(profile: Profile): Raw {
  const out: Raw = { name: profile.name, chain: profile.chain.map(entryJson) };
  if (profile.strategy === "balanced") out.strategy = "balanced";
  if (profile.exhaustionPolicy) out.exhaustionPolicy = profile.exhaustionPolicy;
  if (profile.maxWaitMinutes) out.maxWaitMinutes = profile.maxWaitMinutes;
  return out;
}

function readUsage(raw: unknown): Usage {
  const value = object(raw);
  const windows = Array.isArray(value.windows) ? value.windows.map(object) : [];
  return {
    status: typeof value.status === "string" ? value.status : "unknown",
    windows: windows.map((window) => ({
      name: String(window.name ?? ""),
      usedPercent: typeof window.usedPercent === "number" ? window.usedPercent : 0,
      resetAt: typeof window.resetAt === "number" ? window.resetAt : null,
      durationMs: typeof window.durationMs === "number" ? window.durationMs : null,
      scope: String(window.scope ?? "provider"),
      families: Array.isArray(window.families) ? window.families.map(String) : null,
    })),
    tier: typeof value.tier === "string" ? value.tier : null,
    retrievedAt: typeof value.retrievedAt === "number" ? value.retrievedAt : 0,
    message: typeof value.message === "string" ? value.message : null,
    unlimited: object(value.credits).unlimited === true,
  };
}

async function readConfigRaw(): Promise<{ raw: Raw; error: string | null }> {
  try {
    return { raw: object(await readJson(await routerConfigPath())), error: null };
  } catch (error) {
    return { raw: {}, error: (error as Error).message };
  }
}

export async function routerState(_input: RpcInput<typeof routerStateRpc>): Promise<RpcOutput<typeof routerStateRpc>> {
  const data = path.join(agentDir(), "ext", "subscription-router");
  const { raw, error } = await readConfigRaw();
  const stored = object(object(await readJson(path.join(data, "accounts.json")).catch(() => null)).accounts);
  const snapshots = object(await readJson(path.join(data, "usage.json")).catch(() => null)).snapshots;
  const usageByProvider = new Map<string, Usage>();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : Object.values(object(snapshots))) {
    const provider = object(snapshot).provider;
    if (typeof provider === "string") usageByProvider.set(provider, readUsage(snapshot));
  }
  // Which providers pi holds a login for; only the names are read.
  const logins = new Set(Object.keys(object(await readJson(path.join(agentDir(), "auth.json")).catch(() => null))));
  const version = await piVersion().catch(() => null);
  const policies = object(raw.accounts);
  const providers = SUBSCRIPTION_PROVIDERS.map((family) => {
    const slots = new Map<number, string>([[1, "pi"]]);
    for (const [provider, entry] of Object.entries(stored)) {
      const parsed = parseAccountProvider(provider);
      if (parsed?.base === family.base && parsed.slot > 1) slots.set(parsed.slot, object(entry).type === "oauth" ? "router" : "pi");
    }
    const accounts: SubscriptionAccount[] = [...slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([slot, kind]) => {
        const provider = accountProvider(family.base, slot);
        const login = kind === "router" ? "router" : logins.has(provider) || slot === 1 ? "pi" : "missing";
        return { provider, slot, name: `${family.short} #${slot}`, login, usage: usageByProvider.get(provider) ?? null };
      });
    return { base: family.base, label: family.label, short: family.short, accounts, policy: readPolicy(policies[family.base]) };
  });
  return {
    accountsMode: newerThan(version, LAST_WITHOUT_ACCOUNTS),
    piVersion: version,
    configPath: await routerConfigPath(true),
    configError: error,
    autoSwitchOn429: raw.autoSwitchOn429 !== false,
    providers,
    profiles: readProfiles(raw.profiles),
  };
}

function validateEntries(entries: Entry[], where: string, own?: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const provider = entry.model.split("/")[0];
    if (provider === "router") throw new Error(`${where}: a chain cannot name a router model.`);
    if (entry.account && entry.account > 1 && !parseAccountProvider(provider)) throw new Error(`${where}: only anthropic and openai-codex models have accounts.`);
    if (own && parseAccountProvider(provider)?.base === own) throw new Error(`${where}: ${entry.model} is a model of ${own} itself.`);
    const key = `${entry.model}#${entry.account ?? 1}`;
    if (seen.has(key)) throw new Error(`${where}: ${entry.model} is listed twice.`);
    seen.add(key);
  }
}

async function writeConfig(update: (raw: Raw) => void): Promise<string> {
  const { raw, error } = await readConfigRaw();
  if (error) throw new Error(`The router config cannot be read, so it is not overwritten: ${error}`);
  update(raw);
  // The extension reads a file without profiles only when it has autoSwitchOn429 or accounts.
  if (!raw.profiles) raw.profiles = {};
  const file = await routerConfigPath(true);
  await writeAtomic(file, prettyJson(raw));
  forgetCommands();
  return file;
}

export async function saveRouterPolicy({ provider, policy }: RpcInput<typeof routerPolicySaveRpc>): Promise<RpcOutput<typeof routerPolicySaveRpc>> {
  validateEntries(policy.fallback, `accounts.${provider}.fallback`, provider);
  const file = await writeConfig((raw) => {
    raw.accounts = { ...object(raw.accounts), [provider]: policyJson(policy) };
  });
  return { path: file };
}

export async function saveRouterProfiles({ profiles, autoSwitchOn429 }: RpcInput<typeof routerProfilesSaveRpc>): Promise<RpcOutput<typeof routerProfilesSaveRpc>> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Two profiles are named ${profile.id}.`);
    ids.add(profile.id);
    validateEntries(profile.chain, `profiles.${profile.id}.chain`);
  }
  const file = await writeConfig((raw) => {
    raw.profiles = Object.fromEntries(profiles.map((profile) => [profile.id, profileJson(profile)]));
    if (autoSwitchOn429 === false) raw.autoSwitchOn429 = false;
    else if (autoSwitchOn429 === true) delete raw.autoSwitchOn429;
  });
  return { path: file };
}

const WORDS: Record<string, string> = { anthropic: "claude", "openai-codex": "codex" };

function routerArgs(input: RpcInput<typeof routerRunRpc>): { args: string; timeout: number } {
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined || value === "") throw new Error(`Name the ${what}.`);
    return value;
  };
  switch (input.action) {
    case "refresh":
      return { args: "refresh", timeout: 120_000 };
    case "login-start":
      return { args: `login start ${WORDS[need(input.provider, "provider")] ?? input.provider}`, timeout: 60_000 };
    case "login-finish": {
      const pasted = need(input.pasted, "pasted code").trim();
      if (/\s/.test(pasted)) throw new Error("Paste the code or address without spaces.");
      return { args: `login finish ${need(input.id, "login")} ${pasted}`, timeout: 120_000 };
    }
    case "remove":
      return { args: `remove ${need(input.provider, "account")} --yes`, timeout: 60_000 };
    case "resets-list":
      return { args: "resets --json", timeout: 120_000 };
    case "resets-use":
      return { args: `resets ${need(input.account, "account")} --yes`, timeout: 120_000 };
  }
}

/** Runs `/router <args>` in a temporary pi session; the JSON of the last notice is `data`. */
export async function runRouter(input: RpcInput<typeof routerRunRpc>): Promise<RpcOutput<typeof routerRunRpc>> {
  const { args, timeout } = routerArgs(input);
  const result = await runSlash(agentDir(), "router", args, timeout);
  forgetCommands();
  const failed = result.output.find((notice) => notice.level === "error");
  const output = result.output.map((notice) => notice.text).join("\n").trim();
  if (!result.output.length && result.disposition !== "handled") {
    throw new Error("pi did not run /router. Is the subscription-router extension on?");
  }
  let data: unknown = null;
  for (const notice of [...result.output].reverse()) {
    if (notice.level === "error" || !notice.text.trim().startsWith("{")) continue;
    try {
      data = JSON.parse(notice.text);
      break;
    } catch {
      // Not the command's JSON answer.
    }
  }
  if (failed) return { ok: false, output: failed.text, data: null };
  return { ok: true, output: output || "Done.", data };
}
