// What pi puts in a session besides its built-in prompt: SYSTEM.md and APPEND_SYSTEM.md, context
// files (AGENTS.md, CLAUDE.md), skills, and prompt templates. The rules follow pi-rust's
// crates/pi-coding-agent/src/resources (loader.rs, context.rs, discovery.rs, filters.rs, skills.rs).
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The first of these in a directory is its context file. */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export const ResourceFileSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  /** The file's text; empty when it does not exist. */
  text: z.string(),
  editable: z.boolean(),
  /** Why it cannot be edited, or why pi ignores it. */
  reason: z.string().nullable(),
});
export type ResourceFile = z.infer<typeof ResourceFileSchema>;

export const IncludeSchema = z.object({ line: z.number(), ref: z.string(), path: z.string(), exists: z.boolean() });

export const ContextFileSchema = ResourceFileSchema.extend({
  /** `agent` is pi's agent directory; `workspace` is the workspace directory; `parent` is above it. */
  origin: z.enum(["agent", "parent", "workspace"]),
  bytes: z.number(),
  /** `@path` lines that the context-include extension inlines. */
  includes: z.array(IncludeSchema),
});
export type ContextFile = z.infer<typeof ContextFileSchema>;

export const contextRpc = defineRpc({
  name: "res.context",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    trusted: z.boolean(),
    system: z.object({
      global: ResourceFileSchema,
      project: ResourceFileSchema.nullable(),
      /** The file pi uses: the workspace's when pi trusts it, else the global one, else its built-in prompt. */
      active: z.enum(["project", "global", "default"]),
    }),
    append: z.object({
      global: ResourceFileSchema,
      project: ResourceFileSchema.nullable(),
      active: z.enum(["project", "global", "none"]),
    }),
    /** In the order pi adds them to the prompt. */
    contextFiles: z.array(ContextFileSchema),
    /** Where a context file can be created: the agent directory and the workspace, when they have none. */
    missing: z.array(ResourceFileSchema.extend({ origin: z.enum(["agent", "workspace"]) })),
  }),
});

// Skills and prompt templates ----------------------------------------------------------------------

export const SKILL_LOCATIONS = ["project", "project-agents", "agent", "agents-home", "claude-plugin", "other"] as const;
export type SkillLocation = (typeof SKILL_LOCATIONS)[number];
/** Where a new skill can go. */
export const NEW_SKILL_LOCATIONS = ["agent", "agents-home", "project", "project-agents"] as const;
export type NewSkillLocation = (typeof NEW_SKILL_LOCATIONS)[number];

export const SKILL_LOCATION_LABELS: Record<SkillLocation, string> = {
  project: "Workspace .pi/skills",
  "project-agents": "Workspace .agents/skills",
  agent: "pi skills",
  "agents-home": "~/.agents/skills",
  "claude-plugin": "Claude plugins",
  other: "Packages and settings",
};

export const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** The SKILL.md, or the Markdown file of a single-file skill. */
  path: z.string(),
  location: z.enum(SKILL_LOCATIONS),
  scope: z.enum(["user", "project"]),
  enabled: z.boolean(),
  /** A `skills` settings entry can turn it off. */
  toggleable: z.boolean(),
  editable: z.boolean(),
  /** The Claude plugin that installed it, as `<plugin>@<marketplace>`. */
  plugin: z.string().nullable(),
  /** The path of an earlier skill with the same name, which wins. */
  shadowedBy: z.string().nullable(),
  /** Only `/skill:name` runs it; the model does not see it. */
  manualOnly: z.boolean(),
  source: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type Skill = z.infer<typeof SkillSchema>;

export const RootSchema = z.object({ location: z.string(), path: z.string(), exists: z.boolean(), active: z.boolean() });

export const skillsRpc = defineRpc({
  name: "res.skills",
  input: z.object({ cwd: z.string().optional(), refresh: z.boolean().optional() }),
  output: z.object({
    skills: z.array(SkillSchema),
    roots: z.array(RootSchema),
    trusted: z.boolean(),
    /** `/skill:name` commands are on. */
    skillCommands: z.boolean(),
    warnings: z.array(z.string()),
  }),
});

export const PromptSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  path: z.string(),
  location: z.enum(["project", "agent", "claude-plugin", "other"]),
  scope: z.enum(["user", "project"]),
  enabled: z.boolean(),
  toggleable: z.boolean(),
  editable: z.boolean(),
  plugin: z.string().nullable(),
  shadowedBy: z.string().nullable(),
  source: z.string().nullable(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const promptsRpc = defineRpc({
  name: "res.prompts",
  input: z.object({ cwd: z.string().optional(), refresh: z.boolean().optional() }),
  output: z.object({ prompts: z.array(PromptSchema), roots: z.array(RootSchema), trusted: z.boolean(), warnings: z.array(z.string()) }),
});

export const resourceToggleRpc = defineRpc({
  name: "res.toggle",
  input: z.object({ cwd: z.string().optional(), kind: z.enum(["skills", "prompts"]), path: z.string(), enabled: z.boolean() }),
  output: z.object({ path: z.string() }),
});

/** Skill names as pi checks them: lowercase letters, digits, and single hyphens, at most 64. */
export function skillNameError(name: string): string | null {
  if (!name) return "Name the skill.";
  if (name.length > 64) return "At most 64 characters.";
  if (!/^[a-z0-9-]+$/.test(name)) return "Use lowercase letters, digits, and hyphens.";
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return "No hyphen at the start or end, and no double hyphens.";
  return null;
}

/** Prompt template names become `/<name>`, so they are file names without spaces. */
export function promptNameError(name: string): string | null {
  if (!name) return "Name the prompt.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) return "Use letters, digits, dots, colons, hyphens, and underscores.";
  if (name.length > 80) return "At most 80 characters.";
  return null;
}

export const skillCreateRpc = defineRpc({
  name: "res.skill.create",
  input: z.object({
    cwd: z.string().optional(),
    location: z.enum(NEW_SKILL_LOCATIONS),
    name: z.string().refine((value) => !skillNameError(value), { message: "Invalid skill name." }),
    description: z.string().min(1).max(1024),
    body: z.string(),
  }),
  output: z.object({ path: z.string() }),
});

export const promptCreateRpc = defineRpc({
  name: "res.prompt.create",
  input: z.object({
    cwd: z.string().optional(),
    location: z.enum(["agent", "project"]),
    name: z.string().refine((value) => !promptNameError(value), { message: "Invalid prompt name." }),
    description: z.string(),
    argumentHint: z.string().optional(),
    body: z.string().min(1),
  }),
  output: z.object({ path: z.string() }),
});

/** Deletes a skill: its directory when it has a SKILL.md, else its file. */
export const skillDeleteRpc = defineRpc({
  name: "res.skill.delete",
  input: z.object({ cwd: z.string().optional(), path: z.string() }),
  output: z.object({ path: z.string() }),
});

export const resourceReadRpc = defineRpc({
  name: "res.read",
  input: z.object({ cwd: z.string().optional(), path: z.string() }),
  output: ResourceFileSchema,
});

export const fileWriteRpc = defineRpc({
  name: "res.file.write",
  input: z.object({ cwd: z.string().optional(), path: z.string(), text: z.string() }),
  output: z.object({ path: z.string() }),
});

export const fileDeleteRpc = defineRpc({
  name: "res.file.delete",
  input: z.object({ cwd: z.string().optional(), path: z.string() }),
  output: z.object({ path: z.string() }),
});

/** The `---` front matter of a Markdown file, as flat strings, and the text after it. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, body: normalized };
  const fields: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    let value = rawValue.trim();
    const block = /^([|>])[-+]?$/.exec(value);
    const continuation: string[] = [];
    while (index + 1 < lines.length && (/^[ \t]+\S/.test(lines[index + 1]) || (block && lines[index + 1].trim() === ""))) {
      continuation.push(lines[++index].trim());
    }
    if (block) value = continuation.join(block[1] === "|" ? "\n" : " ").trim();
    else if (continuation.length) value = [value, ...continuation].join(" ").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    fields[key] = value;
  }
  return { fields, body: normalized.slice(match[0].length) };
}

/** A YAML scalar for front matter: quoted when plain text would not parse back the same. */
export function yamlScalar(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, " ").trim();
  return /^[\w][\w .,()/'-]*$/.test(flat) && !/: /.test(flat) ? flat : JSON.stringify(flat);
}
