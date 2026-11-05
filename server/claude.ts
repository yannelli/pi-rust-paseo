// Claude Code plugin marketplaces and plugins of the `claude-marketplace` extension. Lists come from
// its config, state, and the marketplaces' catalogs (as listing.rs builds them); every change runs
// `/claude-plugins <subcommand>` in a temporary pi, since only the extension stages plugin files.
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { claudeArgs, type ClaudePlugin, type claudeRunRpc, type claudeStateRpc, type Marketplace, type PluginResources } from "../shared/claude";
import { readJson } from "./fsutil";
import { claudeRoots } from "./resources";
import { forgetCommands, runSlash } from "./extensions";
import { agentDir } from "./pi";
import { projectTrusted } from "./trust";

interface ConfigFile {
  marketplaces?: Record<string, { source?: unknown; autoUpdate?: unknown }>;
  plugins?: Record<string, { enabled?: unknown }>;
}

interface StateFile {
  marketplaces?: Record<string, { name?: unknown; source?: unknown; gitUrl?: unknown; root?: unknown; manifest?: unknown }>;
  plugins?: Record<
    string,
    {
      plugin?: unknown;
      marketplace?: unknown;
      marketplaceScope?: unknown;
      version?: unknown;
      description?: unknown;
      enabled?: unknown;
      pluginRoot?: unknown;
      files?: unknown;
      hooks?: unknown;
      mcpKeys?: unknown;
      unsupported?: unknown;
    }
  >;
}

interface CatalogEntry {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  source?: unknown;
  category?: unknown;
  author?: unknown;
  homepage?: unknown;
  repository?: unknown;
  keywords?: unknown;
  tags?: unknown;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function author(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return text((value as { name?: unknown }).name);
  return null;
}

/** A plugin source as source.rs reads it: a relative path, a git source, or one pi cannot install. */
export function sourceKind(source: unknown): { remote: boolean; unsupported: string | null } {
  if (typeof source === "string") return { remote: false, unsupported: null };
  const kind = source && typeof source === "object" ? String((source as { source?: unknown }).source ?? "") : "";
  const field = (key: string) => text((source as Record<string, unknown> | null)?.[key]);
  if (kind === "github") return field("repo") ? { remote: true, unsupported: null } : { remote: true, unsupported: "github source without a URL" };
  if (kind === "url" || kind === "git") return field("url") ? { remote: true, unsupported: null } : { remote: true, unsupported: `${kind} source without a URL` };
  if (kind === "git-subdir") return field("path") ? { remote: true, unsupported: null } : { remote: true, unsupported: "git-subdir source without a path" };
  if (kind === "npm") return { remote: true, unsupported: "npm plugin sources are not supported" };
  if (!source) return { remote: false, unsupported: "entry has no source" };
  return { remote: true, unsupported: `unknown plugin source "${kind}"` };
}

/** What an installed plugin staged, from the file list in its state record. */
export function resourcesOf(record: NonNullable<StateFile["plugins"]>[string]): PluginResources {
  const resources: PluginResources = { skills: [], commands: [], agents: [], hooks: record.hooks === true, mcp: strings(record.mcpKeys), unsupported: strings(record.unsupported) };
  for (const file of strings(record.files)) {
    const parts = file.split(/[\\/]/);
    const parent = parts[parts.length - 2];
    const name = parts[parts.length - 1];
    if (parent === "skills") resources.skills.push(name);
    else if (parent === "prompts" && name.endsWith(".md")) resources.commands.push(name.slice(0, -3));
    else if (parent === "agents" && name.endsWith(".md")) resources.agents.push(name.slice(0, -3));
  }
  return resources;
}

export async function claudeState({ cwd }: RpcInput<typeof claudeStateRpc>): Promise<RpcOutput<typeof claudeStateRpc>> {
  const warnings: string[] = [];
  const marketplaces: Marketplace[] = [];
  const plugins: ClaudePlugin[] = [];
  const scopes = claudeRoots(cwd).filter((root) => root.active);
  const read = async <T>(file: string): Promise<T | null> => {
    try {
      return await readJson<T>(file);
    } catch (error) {
      warnings.push(`${file}: ${(error as Error).message}`);
      return null;
    }
  };
  const states = new Map<string, StateFile>();
  for (const root of scopes) states.set(root.scope, (await read<StateFile>(path.join(root.dir, "state.json"))) ?? {});
  const installedRecord = (id: string, marketplaceScope: string) => {
    for (const [scope, state] of states) {
      const record = state.plugins?.[id];
      if (record && (record.marketplaceScope ?? "user") === marketplaceScope) return { scope: scope as "user" | "project", record };
    }
    return null;
  };
  for (const root of scopes) {
    const config = (await read<ConfigFile>(path.join(root.root, "ext", "claude-marketplace.json"))) ?? {};
    const state = states.get(root.scope) ?? {};
    for (const [key, record] of Object.entries(state.marketplaces ?? {})) {
      const name = text(record.name) ?? key;
      const manifest = text(record.manifest);
      const catalog = manifest ? await read<{ name?: unknown; description?: unknown; owner?: unknown; metadata?: { description?: unknown }; plugins?: CatalogEntry[] }>(manifest) : null;
      const entries = Array.isArray(catalog?.plugins) ? catalog!.plugins : [];
      let installed = 0;
      for (const entry of entries) {
        const plugin = text(entry.name);
        if (!plugin) continue;
        const id = `${plugin}@${name}`;
        const found = installedRecord(id, root.scope);
        const kind = sourceKind(entry.source);
        const reasons: string[] = [];
        let status: ClaudePlugin["status"] = "available";
        if (found) {
          installed += 1;
          status = found.record.enabled === false ? "disabled" : "installed";
          reasons.push(...strings(found.record.unsupported).map((part) => `unsupported: ${part}`));
        } else if (kind.unsupported) {
          status = "unavailable";
          reasons.push(kind.unsupported);
        }
        plugins.push({
          id,
          name: plugin,
          marketplace: name,
          scope: found?.scope ?? root.scope,
          status,
          version: text(found?.record.version) ?? text(entry.version),
          description: text(found?.record.description) ?? text(entry.description),
          category: text(entry.category),
          author: author(entry.author),
          homepage: text(entry.homepage) ?? text(entry.repository),
          keywords: [...strings(entry.keywords), ...strings(entry.tags)],
          remote: kind.remote,
          reasons,
          resources: found ? resourcesOf(found.record) : null,
          root: text(found?.record.pluginRoot),
        });
      }
      // Installed plugins that their marketplace no longer lists.
      for (const [id, record] of Object.entries(state.plugins ?? {})) {
        if (text(record.marketplace) !== name || plugins.some((plugin) => plugin.id === id)) continue;
        installed += 1;
        plugins.push({
          id,
          name: text(record.plugin) ?? id.split("@")[0],
          marketplace: name,
          scope: root.scope,
          status: record.enabled === false ? "disabled" : "installed",
          version: text(record.version),
          description: text(record.description),
          category: null,
          author: null,
          homepage: null,
          keywords: [],
          remote: false,
          reasons: ["no longer in the marketplace"],
          resources: resourcesOf(record),
          root: text(record.pluginRoot),
        });
      }
      const autoUpdate = config.marketplaces?.[name]?.autoUpdate === true;
      marketplaces.push({
        name,
        scope: root.scope,
        source: text(record.source) ?? text(config.marketplaces?.[name]?.source) ?? "",
        gitUrl: text(record.gitUrl),
        autoUpdate,
        root: text(record.root) ?? "",
        description: text(catalog?.description) ?? text(catalog?.metadata?.description),
        owner: author(catalog?.owner),
        plugins: entries.length,
        installed,
        error: manifest && !catalog ? "The marketplace catalog could not be read. Update the marketplace to fetch it again." : null,
      });
    }
    // Marketplaces in the config that the extension has not added yet (an edit by hand, or another machine).
    for (const [name, entry] of Object.entries(config.marketplaces ?? {})) {
      if (marketplaces.some((marketplace) => marketplace.name === name && marketplace.scope === root.scope)) continue;
      marketplaces.push({
        name,
        scope: root.scope,
        source: text(entry.source) ?? "",
        gitUrl: null,
        autoUpdate: entry.autoUpdate === true,
        root: "",
        description: null,
        owner: null,
        plugins: 0,
        installed: 0,
        error: "Configured but not fetched yet. Update all to add it.",
      });
    }
  }
  return { marketplaces, plugins, projectTrusted: cwd ? projectTrusted(cwd) : true, warnings };
}

/** Network actions clone or pull repositories, so they get longer than other commands. */
const SLOW_ACTIONS = new Set(["marketplace-add", "marketplace-update", "install", "reinstall", "update", "update-all", "import"]);

export async function claudeRun({ cwd, action, target, scope }: RpcInput<typeof claudeRunRpc>): Promise<RpcOutput<typeof claudeRunRpc>> {
  if (scope === "project") {
    if (!cwd) throw new Error("Choose a workspace for workspace plugins.");
    if (!projectTrusted(cwd)) throw new Error("pi does not trust this workspace, so it would not load its plugins.");
  }
  const args = claudeArgs(action, target, scope);
  // In a workspace the extension sees both scopes; without one it runs in the agent directory.
  const dir = cwd ?? agentDir();
  const result = await runSlash(dir, "claude-plugins", args, SLOW_ACTIONS.has(action) ? 600_000 : 120_000);
  forgetCommands();
  const output = result.output.map((notice) => notice.text).join("\n").trim();
  const failed = result.disposition === "error" || result.output.some((notice) => notice.level === "error");
  if (!output && result.disposition !== "handled") throw new Error("pi did not run /claude-plugins. Is the claude-marketplace extension on?");
  return { ok: !failed, output: output || "Done.", command: `/claude-plugins ${args}` };
}
