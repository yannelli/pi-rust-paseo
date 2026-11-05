// The `deferred` extension's rules (extensions/deferred in pi-rust-extensions): each kind maps a
// pattern to a mode, sources apply in a fixed order, and the last matching rule wins.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFERRED_KINDS = ["tools", "skills", "context", "sections"] as const;
export const DEFERRED_MODES = ["on", "names", "deferred", "user", "off"] as const;
export type DeferredKind = (typeof DEFERRED_KINDS)[number];
export type DeferredMode = (typeof DEFERRED_MODES)[number];

export const MODE_LABELS: Record<DeferredMode, string> = {
  on: "on",
  names: "names",
  deferred: "deferred",
  user: "user",
  off: "off",
};

export const MODE_HELP: Record<DeferredMode, string> = {
  on: "pi loads it as usual",
  names: "out of the prompt, listed by name, loaded on demand",
  deferred: "out of the prompt and unlisted, but searchable",
  user: "skills only: out of the prompt, /skill:name still works",
  off: "out of the prompt, not searchable, and blocked",
};

const ALIASES: Record<string, DeferredMode> = {
  on: "on",
  load: "on",
  eager: "on",
  names: "names",
  name: "names",
  "name-only": "names",
  deferred: "deferred",
  defer: "deferred",
  search: "deferred",
  user: "user",
  manual: "user",
  "user-only": "user",
  off: "off",
  disable: "off",
  disabled: "off",
};

/** The canonical mode of a value as the extension reads it, or null. */
export function canonicalMode(value: unknown): DeferredMode | null {
  return typeof value === "string" ? (ALIASES[value.trim().toLowerCase()] ?? null) : null;
}

export function modesFor(kind: DeferredKind): DeferredMode[] {
  return kind === "skills" ? [...DEFERRED_MODES] : DEFERRED_MODES.filter((mode) => mode !== "user");
}

/** `*` matches any run of characters and `?` one character; the whole name must match. */
export function globMatch(pattern: string, text: string, ignoreCase = false): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, ignoreCase ? "i" : "").test(text);
}

/** Context patterns match a whole path when they start with `/` or `~`, else a trailing part of it. */
export function contextMatch(pattern: string, file: string): boolean {
  if (pattern.startsWith("/") || pattern.startsWith("~")) return globMatch(pattern, file);
  const parts = file.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (globMatch(pattern, parts.slice(i).join("/"))) return true;
  }
  return false;
}

export const RuleSchema = z.object({
  kind: z.enum(DEFERRED_KINDS),
  pattern: z.string(),
  mode: z.enum(DEFERRED_MODES),
  /** Where the rule lives. Repo rules apply in a checkout of that GitHub repository. */
  scope: z.enum(["global", "project", "repo"]),
  repo: z.string().nullable(),
  /** `settings` for the `deferred` setting, which the plugin edits; `file` for deferred.json, read-only like in pi. */
  origin: z.enum(["settings", "file"]),
  /** Whether the rule applies in this workspace: a repo rule of another repo, or an untrusted project, does not. */
  applies: z.boolean(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** The rule that decides `name`: the last matching rule in precedence order, or null for the default `on`. */
export function decide(rules: readonly Rule[], kind: DeferredKind, name: string): Rule | null {
  let winner: Rule | null = null;
  for (const rule of rules) {
    if (!rule.applies || rule.kind !== kind) continue;
    const match = kind === "context" ? contextMatch(rule.pattern, name) : globMatch(rule.pattern, name);
    if (match) winner = rule;
  }
  return winner;
}

export const deferredConfigRpc = defineRpc({
  name: "deferred.config",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    /** All rules in the order the extension applies them; later rules win. */
    rules: z.array(RuleSchema),
    auto: z.union([z.number(), z.literal(false)]),
    maxResults: z.number(),
    /** The `owner/name` of the workspace's `origin` remote, when it has one. */
    repo: z.string().nullable(),
    trusted: z.boolean(),
    sources: z.array(z.object({ label: z.string(), path: z.string(), exists: z.boolean(), editable: z.boolean() })),
    warnings: z.array(z.string()),
  }),
});

export const deferredSetRpc = defineRpc({
  name: "deferred.set",
  input: z.object({
    cwd: z.string().optional(),
    scope: z.enum(["global", "project", "repo"]),
    repo: z.string().optional(),
    kind: z.enum(DEFERRED_KINDS),
    pattern: z
      .string()
      .min(1)
      .refine((value) => !/\s/.test(value), "A pattern cannot contain spaces."),
    /** null removes the rule. */
    mode: z.enum(DEFERRED_MODES).nullable(),
  }),
  output: z.object({ path: z.string() }),
});

export const deferredOptionsRpc = defineRpc({
  name: "deferred.options",
  input: z.object({ auto: z.union([z.number().min(0).max(100), z.literal(false)]), maxResults: z.number().int().min(1).max(50) }),
  output: z.object({ path: z.string() }),
});
