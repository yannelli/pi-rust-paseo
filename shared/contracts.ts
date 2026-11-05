import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DECISIONS, OutputEntrySchema, RunDetailSchema, RunSummarySchema } from "./runs";
import { WorkflowJsonSchema } from "./workflow";

// Settings ------------------------------------------------------------------------------------

export const AGENT_TOOL_MODES = ["all", "non-pi", "off"] as const;

export const pluginSettings = defineSettings({
  id: "pi-rust",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Absolute path of the pi binary; empty finds `$PI_BIN`, then `pi` on PATH. */
    piPath: z.string().default(""),
    /** pi's agent directory; empty uses `$PI_CODING_AGENT_DIR`, then `~/.pi/agent`. */
    agentDir: z.string().default(""),
    /** The `pi-rust-ext` binary that runs workflows; empty reads the installed workflows package. */
    runnerPath: z.string().default(""),
    /** Runs started from Paseo keep going when the plugin stops. */
    defaultBackground: z.boolean().default(true),
    /** Which Paseo agents get the `pi_workflows` and `pi_extensions` tools. */
    agentTools: z.enum(AGENT_TOOL_MODES).default("all"),
    /** Send the run report to the Paseo agent that started a run when the run ends. */
    reportToAgent: z.boolean().default(true),
  }),
});

export type PluginSettingsValues = z.output<typeof pluginSettings.schema>;

// Shared shapes -------------------------------------------------------------------------------

export const ScopeArg = z.enum(["global", "project"]);
export type ScopeName = z.infer<typeof ScopeArg>;

export const CommandResultSchema = z.object({
  ok: z.boolean(),
  code: z.number().nullable(),
  output: z.string(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

const JsonRecord = z.record(z.string(), z.unknown());

// Overview ------------------------------------------------------------------------------------

export const overviewRpc = defineRpc({
  name: "pi.overview",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    pi: z.object({ path: z.string().nullable(), version: z.string().nullable(), error: z.string().nullable() }),
    agentDir: z.string(),
    defaults: z.object({
      provider: z.string().nullable(),
      model: z.string().nullable(),
      thinking: z.string().nullable(),
    }),
    workflows: z.object({
      installed: z.boolean(),
      version: z.string().nullable(),
      runner: z.string().nullable(),
      error: z.string().nullable(),
    }),
    runs: z.object({ active: z.number(), approvals: z.number() }),
    pid: z.number(),
  }),
});

export const doctorRpc = defineRpc({
  name: "pi.doctor",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({ report: JsonRecord.nullable(), error: z.string().nullable() }),
});

export const UPDATE_TARGETS = ["self", "extensions", "models", "all"] as const;

export const updateRpc = defineRpc({
  name: "pi.update",
  input: z.object({ target: z.enum(UPDATE_TARGETS), force: z.boolean().optional() }),
  output: CommandResultSchema,
});

export const ModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  context: z.string(),
  maxOut: z.string(),
  thinking: z.boolean(),
  images: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelSchema>;

export const modelsRpc = defineRpc({
  name: "pi.models",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({ models: z.array(ModelSchema), error: z.string().nullable() }),
});

export const settingsReadRpc = defineRpc({
  name: "pi.settings.read",
  input: z.object({ scope: ScopeArg, cwd: z.string().optional() }),
  output: z.object({ path: z.string(), exists: z.boolean(), text: z.string() }),
});

export const settingsWriteRpc = defineRpc({
  name: "pi.settings.write",
  input: z.object({ scope: ScopeArg, cwd: z.string().optional(), text: z.string() }),
  output: z.object({ path: z.string() }),
});

export const defaultsWriteRpc = defineRpc({
  name: "pi.settings.defaults",
  input: z.object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinking: z.string().nullable().optional(),
  }),
  output: z.object({ path: z.string() }),
});

export const sessionsListRpc = defineRpc({
  name: "pi.sessions.list",
  input: z.object({ cwd: z.string().optional(), all: z.boolean(), limit: z.number().int().positive().optional() }),
  output: z.object({
    sessions: z.array(
      z.object({
        id: z.string(),
        shortId: z.string(),
        path: z.string(),
        cwd: z.string(),
        name: z.string().nullable(),
        firstMessage: z.string(),
        created: z.string().nullable(),
        modified: z.string().nullable(),
        messageCount: z.number(),
        cost: z.number(),
      }),
    ),
  }),
});

export const sessionsRemoveRpc = defineRpc({
  name: "pi.sessions.remove",
  input: z.object({ cwd: z.string().optional(), all: z.boolean(), ids: z.array(z.string()).min(1) }),
  output: CommandResultSchema,
});

export const sessionsPruneRpc = defineRpc({
  name: "pi.sessions.prune",
  input: z.object({
    cwd: z.string().optional(),
    all: z.boolean(),
    olderThan: z.string().regex(/^\d+[smhdw]$/, "a number and a unit (s, m, h, d, w), such as 30d"),
    dryRun: z.boolean(),
  }),
  output: CommandResultSchema,
});

export const statsRpc = defineRpc({
  name: "pi.stats",
  input: z.object({ cwd: z.string().optional(), all: z.boolean() }),
  output: z.object({ report: JsonRecord.nullable(), error: z.string().nullable() }),
});

export const usageRpc = defineRpc({
  name: "pi.usage",
  input: z.object({}),
  output: z.object({ report: z.unknown(), error: z.string().nullable() }),
});

export const dirInfoRpc = defineRpc({
  name: "pi.dir",
  input: z.object({ cwd: z.string().min(1) }),
  output: z.object({
    cwd: z.string(),
    exists: z.boolean(),
    /** pi trusts the directory, so it reads its `.pi/` settings, extensions, and workflows. */
    trusted: z.boolean(),
    hasProjectPi: z.boolean(),
    git: z
      .object({
        top: z.string(),
        branch: z.string().nullable(),
        /** A linked worktree, whose `.pi/` files are its own and go away with it. */
        isWorktree: z.boolean(),
        mainCheckout: z.string(),
        dirty: z.boolean(),
      })
      .nullable(),
  }),
});
export type DirInfo = z.output<typeof dirInfoRpc.output>;

// Extensions ----------------------------------------------------------------------------------

export const ExtensionSchema = z.object({
  reference: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  builtin: z.boolean(),
});
export type ExtensionInfo = z.infer<typeof ExtensionSchema>;

export const PackageSchema = z.object({
  source: z.string(),
  path: z.string().nullable(),
  filtered: z.boolean(),
  scope: ScopeArg,
});
export type PackageInfo = z.infer<typeof PackageSchema>;

export const extensionsListRpc = defineRpc({
  name: "ext.list",
  input: z.object({ scope: ScopeArg, cwd: z.string().optional() }),
  output: z.object({ extensions: z.array(ExtensionSchema), packages: z.array(PackageSchema) }),
});

export const MarketplaceEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  installed: z.string().nullable(),
  description: z.string(),
});
export type MarketplaceEntry = z.infer<typeof MarketplaceEntrySchema>;

export const extensionsSearchRpc = defineRpc({
  name: "ext.search",
  input: z.object({ query: z.string() }),
  output: z.object({ results: z.array(MarketplaceEntrySchema), error: z.string().nullable() }),
});

export const extensionsInfoRpc = defineRpc({
  name: "ext.info",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({
    title: z.string(),
    description: z.string(),
    fields: z.record(z.string(), z.string()),
    text: z.string(),
  }),
});

export const EXTENSION_ACTIONS = ["install", "remove", "enable", "disable", "update"] as const;
export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

export const extensionsRunRpc = defineRpc({
  name: "ext.run",
  input: z.object({
    action: z.enum(EXTENSION_ACTIONS),
    target: z.string().min(1),
    scope: ScopeArg,
    cwd: z.string().optional(),
  }),
  output: CommandResultSchema,
});

// Workflows -----------------------------------------------------------------------------------

export const WorkflowListItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  mode: z.string(),
  context: z.string(),
  background: z.boolean(),
  source: ScopeArg,
  path: z.string(),
  stepCount: z.number(),
  taskCount: z.number(),
  inputs: z.array(z.string()),
  askModels: z.array(z.object({ target: z.number(), label: z.string() })),
  problems: z.array(z.string()),
  /** Each step with its effective model, for a pipeline view. */
  steps: z.array(
    z.object({
      name: z.string(),
      model: z.string().nullable(),
      thinking: z.string().nullable(),
      tasks: z.number(),
      approval: z.boolean(),
      loop: z.boolean(),
      wait: z.boolean(),
    }),
  ),
});
export type WorkflowListItem = z.infer<typeof WorkflowListItemSchema>;

export const workflowsListRpc = defineRpc({
  name: "wf.list",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    workflows: z.array(WorkflowListItemSchema),
    errors: z.array(z.string()),
    globalDir: z.string(),
    projectDir: z.string().nullable(),
    trusted: z.boolean(),
  }),
});

export const workflowGetRpc = defineRpc({
  name: "wf.get",
  input: z.object({ name: z.string().min(1), cwd: z.string().optional(), source: ScopeArg.optional() }),
  output: z.object({ workflow: WorkflowJsonSchema, source: ScopeArg, path: z.string() }),
});

export const workflowSaveRpc = defineRpc({
  name: "wf.save",
  input: z.object({
    workflow: WorkflowJsonSchema,
    scope: ScopeArg,
    cwd: z.string().optional(),
    /** The name and scope the workflow had when the editor opened; a rename removes the old file. */
    previous: z.object({ name: z.string(), scope: ScopeArg }).optional(),
    overwrite: z.boolean().optional(),
  }),
  output: z.object({ name: z.string(), path: z.string(), source: ScopeArg }),
});

export const workflowDeleteRpc = defineRpc({
  name: "wf.delete",
  input: z.object({ name: z.string().min(1), scope: ScopeArg, cwd: z.string().optional() }),
  output: z.object({ path: z.string() }),
});

export const catalogRpc = defineRpc({
  name: "wf.catalog",
  input: z.object({ cwd: z.string().optional(), refresh: z.boolean().optional() }),
  output: z.object({
    skills: z.array(z.string()),
    mcpServers: z.array(z.string()),
    subagents: z.array(z.string()),
    models: z.array(z.string()),
    tools: z.array(z.string()),
    error: z.string().nullable(),
  }),
});

export const workflowDraftRpc = defineRpc({
  name: "wf.draft",
  input: z.object({ description: z.string().min(1), cwd: z.string().optional(), model: z.string().optional() }),
  output: z.object({ workflow: WorkflowJsonSchema, problems: z.array(z.string()) }),
});

// Runs ----------------------------------------------------------------------------------------

export const runsListRpc = defineRpc({
  name: "runs.list",
  input: z.object({
    cwd: z.string().optional(),
    workflow: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

export const runGetRpc = defineRpc({
  name: "runs.get",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ run: RunDetailSchema }),
});

export const runOutputRpc = defineRpc({
  name: "runs.output",
  input: z.object({ id: z.string().min(1), step: z.number().int().nonnegative(), limit: z.number().int().positive().optional() }),
  output: z.object({ entries: z.array(OutputEntrySchema), total: z.number() }),
});

export const runFilesRpc = defineRpc({
  name: "runs.files",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ memory: z.string(), runnerLog: z.string() }),
});

export const runStartRpc = defineRpc({
  name: "runs.start",
  input: z.object({
    /** A saved workflow by name, or `workflow` for an unsaved definition. */
    name: z.string().optional(),
    source: ScopeArg.optional(),
    /** Where a project workflow is saved, when it is not `cwd`, such as a worktree's main checkout. */
    definitionCwd: z.string().optional(),
    workflow: WorkflowJsonSchema.optional(),
    cwd: z.string().min(1),
    inputs: z.record(z.string(), z.string()),
    /** Choices for `ask` models: `-1` for the workflow default, else the step index; null inherits. */
    models: z.record(z.string(), z.string().nullable()).optional(),
    background: z.boolean().optional(),
    /** The Paseo agent whose timeline gets the run card. */
    agentId: z.string().optional(),
    origin: z.enum(["user", "agent"]).optional(),
  }),
  output: z.object({ id: z.string() }),
});

export const RUN_ACTIONS = ["stop", "skip", "approve", "background", "foreground", "resume", "delete"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export const runControlRpc = defineRpc({
  name: "runs.control",
  input: z.object({
    id: z.string().min(1),
    action: z.enum(RUN_ACTIONS),
    decision: z.enum(DECISIONS).optional(),
  }),
  output: z.object({ message: z.string() }),
});

export const runSteerRpc = defineRpc({
  name: "runs.steer",
  input: z.object({ id: z.string().min(1), message: z.string().min(1) }),
  output: z.object({ message: z.string() }),
});

// Timeline ------------------------------------------------------------------------------------

export const RUN_CARD_KIND = "workflow-run";
export const RUN_CARD_VERSION = 1;
export const RunCardSchema = z.object({ runId: z.string(), workflow: z.string() });
export type RunCard = z.infer<typeof RunCardSchema>;
