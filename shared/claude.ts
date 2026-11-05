// Claude Code plugin marketplaces and plugins, as the `claude-marketplace` extension keeps them
// (extensions/claude-marketplace in pi-rust-extensions). The plugin reads its config, state, and
// marketplace catalogs, and changes them only through `/claude-plugins` commands.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CLAUDE_SCOPES = ["user", "project"] as const;
export type ClaudeScope = (typeof CLAUDE_SCOPES)[number];

/** Installed and on; installed and off; in a catalog and installable; in a catalog but not installable. */
export const PLUGIN_STATUSES = ["installed", "disabled", "available", "unavailable"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

export const MarketplaceSchema = z.object({
  name: z.string(),
  scope: z.enum(CLAUDE_SCOPES),
  /** The source as it was added: a git URL, `owner/repo`, or a local path. */
  source: z.string(),
  gitUrl: z.string().nullable(),
  autoUpdate: z.boolean(),
  root: z.string(),
  description: z.string().nullable(),
  owner: z.string().nullable(),
  plugins: z.number(),
  installed: z.number(),
  /** Why the catalog could not be read. */
  error: z.string().nullable(),
});
export type Marketplace = z.infer<typeof MarketplaceSchema>;

export const PluginResourcesSchema = z.object({
  /** Skill names, as pi lists them. */
  skills: z.array(z.string()),
  /** Prompt template names: `/<name>` runs one. */
  commands: z.array(z.string()),
  /** Agent names for the `subagents` extension. */
  agents: z.array(z.string()),
  hooks: z.boolean(),
  /** Keys in pi's mcp.json. */
  mcp: z.array(z.string()),
  /** Plugin parts pi does not support, such as output styles. */
  unsupported: z.array(z.string()),
});
export type PluginResources = z.infer<typeof PluginResourcesSchema>;

export const ClaudePluginSchema = z.object({
  /** `<plugin>@<marketplace>`, the id the commands take. */
  id: z.string(),
  name: z.string(),
  marketplace: z.string(),
  /** Where it is installed, else the scope of its marketplace. */
  scope: z.enum(CLAUDE_SCOPES),
  status: z.enum(PLUGIN_STATUSES),
  version: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  author: z.string().nullable(),
  homepage: z.string().nullable(),
  keywords: z.array(z.string()),
  /** Comes from another repository, so installing it clones that repository. */
  remote: z.boolean(),
  reasons: z.array(z.string()),
  /** What an installed plugin added to pi. */
  resources: PluginResourcesSchema.nullable(),
  root: z.string().nullable(),
});
export type ClaudePlugin = z.infer<typeof ClaudePluginSchema>;

export const claudeStateRpc = defineRpc({
  name: "claude.state",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    marketplaces: z.array(MarketplaceSchema),
    plugins: z.array(ClaudePluginSchema),
    /** pi trusts the workspace, so it reads the workspace's plugins. */
    projectTrusted: z.boolean(),
    warnings: z.array(z.string()),
  }),
});

export const CLAUDE_ACTIONS = [
  "marketplace-add",
  "marketplace-update",
  "marketplace-remove",
  "marketplace-autoupdate",
  "marketplace-noautoupdate",
  "install",
  "reinstall",
  "update",
  "uninstall",
  "enable",
  "disable",
  "update-all",
  "import",
] as const;
export type ClaudeAction = (typeof CLAUDE_ACTIONS)[number];

const Word = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), "Spaces are not allowed here.");

export const claudeRunRpc = defineRpc({
  name: "claude.run",
  input: z.object({
    cwd: z.string().optional(),
    action: z.enum(CLAUDE_ACTIONS),
    /** A marketplace source, a marketplace name, or a plugin id, as the action needs. */
    target: Word.optional(),
    /** For adding a marketplace, installing, and importing. */
    scope: z.enum(CLAUDE_SCOPES).optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** What the extension reported. */
    output: z.string(),
    command: z.string(),
  }),
});

/** The `/claude-plugins` arguments of an action. */
export function claudeArgs(action: ClaudeAction, target?: string, scope?: ClaudeScope): string {
  const need = (what: string) => {
    if (!target) throw new Error(`Name the ${what}.`);
    return target;
  };
  const scoped = (args: string) => (scope ? `${args} --scope ${scope}` : args);
  switch (action) {
    case "marketplace-add":
      return scoped(`marketplace add ${need("marketplace source")}`);
    case "marketplace-update":
      return target ? `marketplace update ${target}` : "marketplace update";
    case "marketplace-remove":
      return scoped(`marketplace remove ${need("marketplace")}`);
    case "marketplace-autoupdate":
      return `marketplace autoupdate ${need("marketplace")}`;
    case "marketplace-noautoupdate":
      return `marketplace noautoupdate ${need("marketplace")}`;
    case "install":
      return scoped(`install ${need("plugin")}`);
    case "update-all":
      return "update";
    case "import":
      return scoped("import");
    default:
      return scoped(`${action} ${need("plugin")}`);
  }
}
