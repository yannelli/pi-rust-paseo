// SYSTEM.md, APPEND_SYSTEM.md, context files, skills, and prompt templates, found and filtered the
// way pi-rust does (crates/pi-coding-agent/src/resources). Writes stay inside the places pi reads.
import { promises as fs, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  CONTEXT_FILE_NAMES,
  parseFrontmatter,
  skillNameError,
  yamlScalar,
  type ContextFile,
  type contextRpc,
  type fileDeleteRpc,
  type fileWriteRpc,
  type Prompt,
  type promptCreateRpc,
  type promptsRpc,
  type ResourceFile,
  type resourceReadRpc,
  type resourceToggleRpc,
  type Skill,
  type skillCreateRpc,
  type skillDeleteRpc,
  type SkillLocation,
  type skillsRpc,
} from "../shared/resources";
import { exists, listDir, prettyJson, readJson, readText, writeAtomic } from "./fsutil";
import { readSettingsObject, settingsPath } from "./manage";
import { forgetCommands, piCommands } from "./extensions";
import { agentDir, projectDir } from "./pi";
import { projectTrusted, trustedOnceNeeded } from "./trust";

const UNTRUSTED = "pi does not trust this workspace, so it ignores this file.";
const WILL_ASK = "pi does not trust this workspace yet: it ignores this file until you trust the workspace.";

function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

function posix(file: string): string {
  return file.split(path.sep).join("/");
}

async function kind(file: string): Promise<{ file: boolean; dir: boolean } | null> {
  try {
    const stat = await fs.stat(file);
    return { file: stat.isFile(), dir: stat.isDirectory() };
  } catch {
    return null;
  }
}

async function resourceFile(file: string, editable: boolean, reason: string | null): Promise<ResourceFile> {
  const text = await readText(file).catch(() => null);
  return { path: file, exists: text !== null, text: text ?? "", editable, reason };
}

/** The reason pi would ignore a project file, or null when it reads it. */
function projectReason(cwd: string): string | null {
  if (projectTrusted(cwd)) return null;
  return trustedOnceNeeded(cwd) ? null : UNTRUSTED;
}

// Context -----------------------------------------------------------------------------------------

async function contextFileIn(dir: string): Promise<string | null> {
  // The names differ only in case; on a case-insensitive disk the first one that exists wins.
  const entries = new Set(await listDir(dir).catch(() => [] as string[]));
  for (const name of CONTEXT_FILE_NAMES) {
    if (!entries.has(name)) continue;
    const file = path.join(dir, name);
    if ((await kind(file))?.file) return file;
  }
  return null;
}

/** The agent directory's context file, then one per directory from the root down to `cwd`. */
export async function contextFilePaths(cwd: string | undefined): Promise<{ path: string; origin: ContextFile["origin"] }[]> {
  const out: { path: string; origin: ContextFile["origin"] }[] = [];
  const own = await contextFileIn(agentDir());
  if (own) out.push({ path: own, origin: "agent" });
  if (!cwd) return out;
  const found: { path: string; origin: ContextFile["origin"] }[] = [];
  const workspace = path.resolve(cwd);
  for (const dir of ancestors(workspace)) {
    const file = await contextFileIn(dir);
    if (file && !out.some((entry) => entry.path === file) && !found.some((entry) => entry.path === file)) {
      found.push({ path: file, origin: dir === workspace ? "workspace" : "parent" });
    }
  }
  return [...out, ...found.reverse()];
}

const INCLUDE_LINE = /^\s*(?:[-*+]\s+)?@(\S+)\s*$/;

/** `@path` lines of a context file, resolved as the context-include extension does. */
export async function includesOf(file: string, text: string): Promise<ContextFile["includes"]> {
  const out: ContextFile["includes"] = [];
  let fenced = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : INCLUDE_LINE.exec(line);
    if (!match) continue;
    const ref = match[1];
    const target = ref === "~" || ref.startsWith("~/") ? path.join(homedir(), ref.slice(1)) : path.resolve(path.dirname(file), ref);
    out.push({ line: index + 1, ref, path: target, exists: Boolean((await kind(target))?.file) });
  }
  return out;
}

export async function context({ cwd }: RpcInput<typeof contextRpc>): Promise<RpcOutput<typeof contextRpc>> {
  const agent = agentDir();
  const trusted = cwd ? projectTrusted(cwd) : true;
  const reason = cwd ? projectReason(cwd) : null;
  const pair = async (name: string) => {
    const global = await resourceFile(path.join(agent, name), true, null);
    const project = cwd ? await resourceFile(path.join(projectDir(cwd), name), true, reason ?? (trusted ? null : WILL_ASK)) : null;
    return { global, project };
  };
  const system = await pair("SYSTEM.md");
  const append = await pair("APPEND_SYSTEM.md");
  const contextFiles: ContextFile[] = [];
  for (const entry of await contextFilePaths(cwd)) {
    const text = (await readText(entry.path).catch(() => null)) ?? "";
    contextFiles.push({
      path: entry.path,
      exists: true,
      text,
      editable: true,
      reason: null,
      origin: entry.origin,
      bytes: Buffer.byteLength(text),
      includes: await includesOf(entry.path, text),
    });
  }
  const missing: RpcOutput<typeof contextRpc>["missing"] = [];
  if (!contextFiles.some((file) => file.origin === "agent")) missing.push({ ...(await resourceFile(path.join(agent, "AGENTS.md"), true, null)), origin: "agent" });
  if (cwd && !contextFiles.some((file) => file.origin === "workspace")) missing.push({ ...(await resourceFile(path.join(path.resolve(cwd), "AGENTS.md"), true, null)), origin: "workspace" });
  return {
    trusted,
    system: { ...system, active: system.project?.exists && trusted ? "project" : system.global.exists ? "global" : "default" },
    append: { ...append, active: append.project?.exists && trusted ? "project" : append.global.exists ? "global" : "none" },
    contextFiles,
    missing,
  };
}

// Settings filters (filters.rs) --------------------------------------------------------------------

/** A glob as pi's globset builds it, with `*` stopping at `/`. */
export function globRegex(pattern: string): RegExp {
  let out = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else if (char === "{") out += "(?:";
    else if (char === "}") out += ")";
    else if (char === "," && out.includes("(?:")) out += "|";
    else if (char === "[" || char === "]") out += char;
    else out += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function normalizeEntry(entry: string): string {
  const trimmed = entry.trim().replace(/^\.\//, "");
  if (trimmed === "~") return posix(homedir());
  if (trimmed.startsWith("~/")) return posix(path.join(homedir(), trimmed.slice(2)));
  return posix(trimmed);
}

/** The forms an entry may name a file by: relative to `base`, its name, and its absolute path, and the same for a skill's directory. */
function candidates(file: string, base: string): { matched: string[]; exact: string[] } {
  const name = path.basename(file);
  const matched = [posix(path.relative(base, file)), name, posix(file)];
  const exact = [posix(path.relative(base, file)), posix(file)];
  if (name === "SKILL.md") {
    const dir = path.dirname(file);
    matched.push(posix(path.relative(base, dir)), path.basename(dir), posix(dir));
    exact.push(posix(path.relative(base, dir)), posix(dir));
  }
  return { matched, exact };
}

function namesExactly(file: string, entry: string, base: string): boolean {
  return candidates(file, base).exact.includes(normalizeEntry(entry));
}

/** Whether a discovered file stays on under the `!`, `+`, and `-` entries of a settings array. */
export function enabledByEntries(file: string, entries: readonly string[], base: string): boolean {
  const { matched } = candidates(file, base);
  let enabled = !entries.some((entry) => entry.startsWith("!") && matched.some((candidate) => globRegex(normalizeEntry(entry.slice(1))).test(candidate)));
  if (entries.some((entry) => entry.startsWith("+") && namesExactly(file, entry.slice(1), base))) enabled = true;
  if (entries.some((entry) => entry.startsWith("-") && namesExactly(file, entry.slice(1), base))) enabled = false;
  return enabled;
}

/** The settings entries after turning `file` on or off: as `pi config`, a `+` or `-` entry, last. */
export function toggledEntries(entries: readonly string[], file: string, base: string, enabled: boolean): string[] {
  const kept = entries.filter((entry) => !((entry.startsWith("+") || entry.startsWith("-")) && namesExactly(file, entry.slice(1), base)));
  if (enabledByEntries(file, kept, base) === enabled) return kept;
  return [...kept, `${enabled ? "+" : "-"}${posix(file)}`];
}

function entriesOf(settings: Record<string, unknown>, key: "skills" | "prompts"): string[] {
  const value = settings[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// Skills and prompts ----------------------------------------------------------------------------------

interface Root {
  location: SkillLocation;
  dir: string;
  /** What settings entries are relative to. */
  base: string;
  scope: "user" | "project";
  mode: "pi" | "agents";
  /** pi reads it: project roots need trust. */
  active: boolean;
  editable: boolean;
}

function gitRoot(start: string): string | null {
  for (const dir of ancestors(start)) {
    try {
      statSync(path.join(dir, ".git"));
      return dir;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Skill directories in the order pi ranks them; the first skill of a name wins. */
export function skillRoots(cwd: string | undefined): Root[] {
  const roots: Root[] = [];
  const userAgents = path.join(homedir(), ".agents", "skills");
  if (cwd) {
    const trusted = projectTrusted(cwd);
    const workspace = path.resolve(cwd);
    roots.push({ location: "project", dir: path.join(projectDir(workspace), "skills"), base: projectDir(workspace), scope: "project", mode: "pi", active: trusted, editable: true });
    const top = gitRoot(workspace);
    for (const dir of ancestors(workspace)) {
      const skills = path.join(dir, ".agents", "skills");
      if (skills !== userAgents) roots.push({ location: "project-agents", dir: skills, base: path.join(dir, ".agents"), scope: "project", mode: "agents", active: trusted, editable: true });
      if (dir === top) break;
    }
  }
  roots.push({ location: "agent", dir: path.join(agentDir(), "skills"), base: agentDir(), scope: "user", mode: "pi", active: true, editable: true });
  roots.push({ location: "agents-home", dir: userAgents, base: path.join(homedir(), ".agents"), scope: "user", mode: "agents", active: true, editable: true });
  for (const plugin of claudeRoots(cwd)) {
    roots.push({ location: "claude-plugin", dir: path.join(plugin.dir, "resources", "skills"), base: plugin.dir, scope: plugin.scope, mode: "pi", active: plugin.active, editable: false });
  }
  return roots;
}

function promptRoots(cwd: string | undefined): Root[] {
  const roots: Root[] = [];
  if (cwd) {
    const workspace = path.resolve(cwd);
    roots.push({ location: "project", dir: path.join(projectDir(workspace), "prompts"), base: projectDir(workspace), scope: "project", mode: "pi", active: projectTrusted(cwd), editable: true });
  }
  roots.push({ location: "agent", dir: path.join(agentDir(), "prompts"), base: agentDir(), scope: "user", mode: "pi", active: true, editable: true });
  for (const plugin of claudeRoots(cwd)) {
    roots.push({ location: "claude-plugin", dir: path.join(plugin.dir, "resources", "prompts"), base: plugin.dir, scope: plugin.scope, mode: "pi", active: plugin.active, editable: false });
  }
  return roots;
}

/** The claude-marketplace extension's directories: one in the agent directory, one per trusted workspace. */
export function claudeRoots(cwd: string | undefined): { scope: "user" | "project"; root: string; dir: string; active: boolean }[] {
  const out: { scope: "user" | "project"; root: string; dir: string; active: boolean }[] = [
    { scope: "user", root: agentDir(), dir: path.join(agentDir(), "ext", "claude-marketplace"), active: true },
  ];
  if (cwd) out.push({ scope: "project", root: projectDir(path.resolve(cwd)), dir: path.join(projectDir(path.resolve(cwd)), "ext", "claude-marketplace"), active: projectTrusted(cwd) });
  return out;
}

/** Skill files under `dir`, as discovery.rs walks it: a SKILL.md ends the search in its directory. */
export async function skillFiles(dir: string, mode: "pi" | "agents", root = dir, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 8 || out.length > 2000) return out;
  const names = (await listDir(dir).catch(() => [] as string[])).sort();
  if (names.includes("SKILL.md") && (await kind(path.join(dir, "SKILL.md")))?.file) {
    out.push(path.join(dir, "SKILL.md"));
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const file = path.join(dir, name);
    const type = await kind(file);
    if (!type) continue;
    const atRoot = dir === root;
    if (type.file && name.endsWith(".md") && (mode === "pi" ? atRoot : !atRoot)) out.push(file);
    else if (type.dir) await skillFiles(file, mode, root, depth + 1, out);
  }
  return out;
}

async function promptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await listDir(dir).catch(() => [] as string[])).sort()) {
    if (name.startsWith(".") || !name.endsWith(".md")) continue;
    if ((await kind(path.join(dir, name)))?.file) out.push(path.join(dir, name));
  }
  return out;
}

/** `<plugin>@<marketplace>` of each staged file, from the extension's state files. */
async function claudeOwners(cwd: string | undefined): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const root of claudeRoots(cwd)) {
    const state = await readJson<{ plugins?: Record<string, { files?: unknown }> }>(path.join(root.dir, "state.json")).catch(() => null);
    for (const [id, record] of Object.entries(state?.plugins ?? {})) {
      for (const file of Array.isArray(record.files) ? record.files : []) if (typeof file === "string") owners.set(path.resolve(file), id);
    }
  }
  return owners;
}

function ownerOf(owners: Map<string, string>, file: string): string | null {
  return owners.get(path.resolve(file)) ?? owners.get(path.dirname(path.resolve(file))) ?? null;
}

async function settingsEntries(cwd: string | undefined, key: "skills" | "prompts"): Promise<{ user: string[]; project: string[] }> {
  const user = entriesOf(await readSettingsObject("global").catch(() => ({})), key);
  const project = cwd && projectTrusted(cwd) ? entriesOf(await readSettingsObject("project", cwd).catch(() => ({})), key) : [];
  return { user, project };
}

/** pi's own list, for skills and prompts that come from packages or settings entries. */
async function probe(cwd: string | undefined, refresh: boolean, warnings: string[]) {
  try {
    return await piCommands(cwd ?? homedir(), refresh);
  } catch (error) {
    warnings.push(`pi did not list its commands: ${(error as Error).message}`);
    return [];
  }
}

export async function skills({ cwd, refresh }: RpcInput<typeof skillsRpc>): Promise<RpcOutput<typeof skillsRpc>> {
  const warnings: string[] = [];
  const roots = skillRoots(cwd);
  const [entries, owners, commands, settings] = await Promise.all([
    settingsEntries(cwd, "skills"),
    claudeOwners(cwd),
    probe(cwd, Boolean(refresh), warnings),
    readSettingsObject("global").catch((): Record<string, unknown> => ({})),
  ]);
  const found: Skill[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of await skillFiles(root.dir, root.mode)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = (await readText(file).catch(() => null)) ?? "";
      const { fields } = parseFrontmatter(text);
      const declared = path.basename(file) === "SKILL.md";
      const description = (fields.description ?? "").trim();
      if (!declared && !description) continue;
      const name = fields.name?.trim() || path.basename(path.dirname(file));
      const skillWarnings: string[] = [];
      const nameError = skillNameError(name);
      if (nameError) skillWarnings.push(`Name "${name}": ${nameError}`);
      if (!description) skillWarnings.push("It has no description, so pi does not load it.");
      if (description.length > 1024) skillWarnings.push("The description is longer than 1024 characters.");
      const scoped = root.scope === "project" ? entries.project : entries.user;
      const toggleable = root.location !== "claude-plugin";
      found.push({
        name,
        description,
        path: file,
        location: root.location,
        scope: root.scope,
        enabled: root.active && Boolean(description) && (!toggleable || enabledByEntries(file, scoped, root.base)),
        toggleable: toggleable && root.active,
        editable: root.editable,
        plugin: root.location === "claude-plugin" ? ownerOf(owners, file) : null,
        shadowedBy: null,
        manualOnly: fields["disable-model-invocation"] === "true",
        source: null,
        warnings: skillWarnings,
      });
    }
  }
  // Skills pi lists that are in none of these directories come from packages or settings entries; they rank first.
  const others: Skill[] = commands
    .filter((command) => command.source === "skill" && command.sourceInfo?.path && !seen.has(path.resolve(command.sourceInfo.path)))
    .map((command) => ({
      name: (command.name ?? "").replace(/^skill:/, ""),
      description: command.description ?? "",
      path: path.resolve(command.sourceInfo!.path!),
      location: "other" as const,
      scope: command.sourceInfo?.scope === "project" ? ("project" as const) : ("user" as const),
      enabled: true,
      toggleable: false,
      editable: false,
      plugin: null,
      shadowedBy: null,
      manualOnly: false,
      source: command.sourceInfo?.source ?? null,
      warnings: [],
    }));
  const all = [...others, ...found];
  const winners = new Map<string, string>();
  for (const skill of all) {
    if (!skill.enabled) continue;
    const winner = winners.get(skill.name);
    if (winner) skill.shadowedBy = winner;
    else winners.set(skill.name, skill.path);
  }
  const rootList = [];
  for (const root of roots) rootList.push({ location: root.location, path: root.dir, exists: await exists(root.dir), active: root.active });
  return {
    skills: all,
    roots: rootList,
    trusted: cwd ? projectTrusted(cwd) : true,
    skillCommands: settings.enableSkillCommands !== false,
    warnings,
  };
}

export async function prompts({ cwd, refresh }: RpcInput<typeof promptsRpc>): Promise<RpcOutput<typeof promptsRpc>> {
  const warnings: string[] = [];
  const roots = promptRoots(cwd);
  const [entries, owners, commands] = await Promise.all([settingsEntries(cwd, "prompts"), claudeOwners(cwd), probe(cwd, Boolean(refresh), warnings)]);
  const found: Prompt[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of await promptFiles(root.dir)) {
      seen.add(file);
      const text = (await readText(file).catch(() => null)) ?? "";
      const { fields, body } = parseFrontmatter(text);
      const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
      const toggleable = root.location !== "claude-plugin";
      const scoped = root.scope === "project" ? entries.project : entries.user;
      found.push({
        name: path.basename(file, ".md"),
        description: fields.description?.trim() || (firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine),
        argumentHint: fields["argument-hint"]?.trim() || null,
        path: file,
        location: root.location === "claude-plugin" ? "claude-plugin" : root.location === "project" ? "project" : "agent",
        scope: root.scope,
        enabled: root.active && (!toggleable || enabledByEntries(file, scoped, root.base)),
        toggleable: toggleable && root.active,
        editable: root.editable,
        plugin: root.location === "claude-plugin" ? ownerOf(owners, file) : null,
        shadowedBy: null,
        source: null,
      });
    }
  }
  const others: Prompt[] = commands
    .filter((command) => command.source === "prompt" && command.sourceInfo?.path && !seen.has(path.resolve(command.sourceInfo.path)))
    .map((command) => ({
      name: command.name ?? "",
      description: command.description ?? "",
      argumentHint: null,
      path: path.resolve(command.sourceInfo!.path!),
      location: "other" as const,
      scope: command.sourceInfo?.scope === "project" ? ("project" as const) : ("user" as const),
      enabled: true,
      toggleable: false,
      editable: false,
      plugin: null,
      shadowedBy: null,
      source: command.sourceInfo?.source ?? null,
    }));
  const all = [...others, ...found];
  const winners = new Map<string, string>();
  for (const prompt of all) {
    if (!prompt.enabled) continue;
    const winner = winners.get(prompt.name);
    if (winner) prompt.shadowedBy = winner;
    else winners.set(prompt.name, prompt.path);
  }
  const rootList = [];
  for (const root of roots) rootList.push({ location: root.location, path: root.dir, exists: await exists(root.dir), active: root.active });
  return { prompts: all, roots: rootList, trusted: cwd ? projectTrusted(cwd) : true, warnings };
}

export async function toggleResource({ cwd, kind: key, path: target, enabled }: RpcInput<typeof resourceToggleRpc>): Promise<RpcOutput<typeof resourceToggleRpc>> {
  const file = path.resolve(target);
  const roots = (key === "skills" ? skillRoots(cwd) : promptRoots(cwd)).filter((root) => root.location !== "claude-plugin");
  const root = roots.find((candidate) => within(file, candidate.dir));
  if (!root) throw new Error(`${file} is not in a ${key === "skills" ? "skill" : "prompt"} directory that pi reads.`);
  const scope = root.scope === "project" ? "project" : "global";
  const settings = await readSettingsObject(scope, cwd);
  if (settings[key] !== undefined && !Array.isArray(settings[key])) throw new Error(`"${key}" in ${settingsPath(scope, cwd)} is not a list.`);
  const next = toggledEntries(entriesOf(settings, key), file, root.base, enabled);
  if (next.length) settings[key] = next;
  else delete settings[key];
  const written = settingsPath(scope, cwd);
  await writeAtomic(written, prettyJson(settings));
  forgetCommands();
  return { path: written };
}

const NEW_SKILL_DIRS = {
  agent: () => path.join(agentDir(), "skills"),
  "agents-home": () => path.join(homedir(), ".agents", "skills"),
  project: (cwd: string) => path.join(projectDir(cwd), "skills"),
  "project-agents": (cwd: string) => path.join(path.resolve(cwd), ".agents", "skills"),
} as const;

export async function createSkill({ cwd, location, name, description, body }: RpcInput<typeof skillCreateRpc>): Promise<RpcOutput<typeof skillCreateRpc>> {
  if ((location === "project" || location === "project-agents") && !cwd) throw new Error("Choose a workspace for a workspace skill.");
  const dir = path.join(NEW_SKILL_DIRS[location](cwd ?? ""), name);
  const file = path.join(dir, "SKILL.md");
  if (await exists(dir)) throw new Error(`${dir} already exists.`);
  const text = `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${body.trim() ? `${body.trim()}\n` : `# ${name}\n`}`;
  await writeAtomic(file, text);
  forgetCommands();
  return { path: file };
}

export async function createPrompt({ cwd, location, name, description, argumentHint, body }: RpcInput<typeof promptCreateRpc>): Promise<RpcOutput<typeof promptCreateRpc>> {
  if (location === "project" && !cwd) throw new Error("Choose a workspace for a workspace prompt.");
  const dir = location === "project" ? path.join(projectDir(cwd!), "prompts") : path.join(agentDir(), "prompts");
  const file = path.join(dir, `${name}.md`);
  if (await exists(file)) throw new Error(`${file} already exists.`);
  const front = [description.trim() ? `description: ${yamlScalar(description)}` : null, argumentHint?.trim() ? `argument-hint: ${yamlScalar(argumentHint)}` : null].filter(Boolean);
  const text = `${front.length ? `---\n${front.join("\n")}\n---\n\n` : ""}${body.trim()}\n`;
  await writeAtomic(file, text);
  forgetCommands();
  return { path: file };
}

export async function deleteSkill({ cwd, path: target }: RpcInput<typeof skillDeleteRpc>): Promise<RpcOutput<typeof skillDeleteRpc>> {
  const file = path.resolve(target);
  const root = skillRoots(cwd).find((candidate) => candidate.editable && within(file, candidate.dir));
  if (!root || file === root.dir) throw new Error(`${file} is not a skill pi reads from a skill directory.`);
  if (path.basename(file) === "SKILL.md") {
    const dir = path.dirname(file);
    if (dir === root.dir) throw new Error("Refusing to delete a whole skills directory.");
    await fs.rm(dir, { recursive: true });
    forgetCommands();
    return { path: dir };
  }
  await fs.rm(file);
  forgetCommands();
  return { path: file };
}

// Files -----------------------------------------------------------------------------------------------

/** Where a write is allowed: the files and directories pi reads prompts, context, skills, and prompt templates from. */
async function writable(file: string, cwd: string | undefined): Promise<string | null> {
  if (!file.endsWith(".md") && !file.endsWith(".MD")) return "Only Markdown files can be edited here.";
  const agent = agentDir();
  const system = ["SYSTEM.md", "APPEND_SYSTEM.md"];
  if (system.some((name) => file === path.join(agent, name))) return null;
  if (cwd && system.some((name) => file === path.join(projectDir(path.resolve(cwd)), name))) return null;
  if ((CONTEXT_FILE_NAMES as readonly string[]).includes(path.basename(file))) {
    const dir = path.dirname(file);
    if (dir === agent || (cwd && ancestors(path.resolve(cwd)).includes(dir))) return null;
  }
  if (skillRoots(cwd).some((root) => root.editable && within(file, root.dir) && file !== root.dir)) return null;
  if (promptRoots(cwd).some((root) => root.editable && path.dirname(file) === root.dir)) return null;
  return `${file} is not a file pi reads prompts, context, skills, or prompt templates from.`;
}

async function readable(file: string, cwd: string | undefined): Promise<boolean> {
  if ((await writable(file, cwd)) === null) return true;
  if ([...skillRoots(cwd), ...promptRoots(cwd)].some((root) => within(file, root.dir))) return true;
  // Skills and prompts of packages and settings entries are wherever pi found them.
  const commands = await piCommands(cwd ?? homedir()).catch(() => []);
  return commands.some((command) => command.sourceInfo?.path && path.resolve(command.sourceInfo.path) === file);
}

export async function readResource({ cwd, path: target }: RpcInput<typeof resourceReadRpc>): Promise<RpcOutput<typeof resourceReadRpc>> {
  const file = path.resolve(target);
  if (!(await readable(file, cwd))) throw new Error(`${file} is not a file pi reads.`);
  const problem = await writable(file, cwd);
  const owner = [...skillRoots(cwd), ...promptRoots(cwd)].find((root) => root.location === "claude-plugin" && within(file, root.dir));
  return resourceFile(file, problem === null, problem === null ? null : owner ? "A Claude plugin installed this file; reinstalling the plugin replaces it." : "pi reads this file from a package or a settings entry.");
}

export async function writeFile({ cwd, path: target, text }: RpcInput<typeof fileWriteRpc>): Promise<RpcOutput<typeof fileWriteRpc>> {
  const file = path.resolve(target);
  const problem = await writable(file, cwd);
  if (problem) throw new Error(problem);
  await writeAtomic(file, text.endsWith("\n") || !text ? text : `${text}\n`);
  forgetCommands();
  return { path: file };
}

export async function deleteFile({ cwd, path: target }: RpcInput<typeof fileDeleteRpc>): Promise<RpcOutput<typeof fileDeleteRpc>> {
  const file = path.resolve(target);
  const problem = await writable(file, cwd);
  if (problem) throw new Error(problem);
  await fs.rm(file);
  forgetCommands();
  return { path: file };
}
