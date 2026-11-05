import type { PluginClientContext, PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { piRustIcon } from "./client/brand";
import { setClient, PANEL_ID, SCREEN_ID, type ManagerParams } from "./client/host";
import { createWorktree } from "./client/workspaces";
import { ManagerScreen, WorkflowsPanel } from "./client/manager";
import { SettingsScreen } from "./client/settings";
import { SidebarItem } from "./client/sidebar";
import { startStatusPills } from "./client/status";
import { RunCardRow } from "./client/timeline-card";
import {
  extensionsRunRpc,
  RUN_CARD_KIND,
  RUN_CARD_VERSION,
  RunCardSchema,
  runControlRpc,
  runsListRpc,
  runStartRpc,
  workflowsListRpc,
} from "./shared/contracts";
import { isActive } from "./shared/runs";
import { parseExtensionCommand, parseWorkflowCommand, WORKFLOW_USAGE, EXTENSION_USAGE } from "./shared/slash";

function open(context: Pick<PluginCommandCapabilities, "openScreen">, params: ManagerParams = {}) {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) if (value) clean[key] = value;
  context.openScreen({ screenId: SCREEN_ID, params: clean });
}

/** The one run that waits for approval, preferring runs in `cwd`. */
async function waitingRun(rpc: PluginCommandCapabilities["rpc"], cwd: string): Promise<string> {
  const { runs } = await rpc(runsListRpc, { limit: 200 });
  const waiting = runs.filter((run) => isActive(run.status) && !run.stale && run.approval);
  const here = waiting.filter((run) => run.cwd === cwd);
  const pool = here.length > 0 ? here : waiting;
  if (pool.length === 1) return pool[0].id;
  if (pool.length === 0) throw new Error("No workflow run waits for an approval.");
  throw new Error(`Several runs wait for an approval: ${pool.map((run) => `${run.id} (${run.workflow})`).join(", ")}. Name one.`);
}

export default function contribute(client: PluginClientContext) {
  setClient(client);

  client.addScreen({
    id: SCREEN_ID,
    title: (params) => (params.run ? `Pi Rust · ${params.run}` : "Pi Rust"),
    Component: ManagerScreen,
  });
  client.addSidebarHeaderItem({ id: "pi-rust", title: "Pi Rust", Component: SidebarItem });
  client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Workflows",
    icon: "Workflow",
    locations: ["workspace", "explorer"],
    Component: WorkflowsPanel,
  });
  client.addSettingsScreen({ id: "settings", title: "Pi Rust", icon: { svg: piRustIcon }, Component: SettingsScreen });
  client.addTimelineRenderer({
    kind: RUN_CARD_KIND,
    version: RUN_CARD_VERSION,
    schema: RunCardSchema,
    Component: RunCardRow,
  });

  client.addCommandCenterItem({
    id: "open",
    title: "Pi Rust: Open",
    icon: { svg: piRustIcon },
    keywords: ["pi", "pi rust", "pi-rust", "overview", "doctor", "update"],
    context: "global",
    onSelect: (context) => open(context),
  });
  client.addCommandCenterItem({
    id: "extensions",
    title: "Pi Rust: Manage extensions",
    icon: "Puzzle",
    keywords: ["pi", "extensions", "marketplace", "install"],
    context: "global",
    onSelect: (context) => open(context, { tab: "extensions" }),
  });
  client.addCommandCenterItem({
    id: "runs",
    title: "Pi Rust: Workflow runs",
    icon: "Activity",
    keywords: ["pi", "workflow", "runs", "approve"],
    context: "global",
    onSelect: (context) => open(context, { tab: "runs" }),
  });
  client.addCommandCenterItem({
    id: "workspace-workflows",
    title: "Pi Rust: Workflows in this workspace",
    icon: "Workflow",
    keywords: ["pi", "workflow", "run", "panel"],
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel(PANEL_ID),
  });
  client.addCommandCenterItem({
    id: "workspace-manage",
    title: "Pi Rust: Manage this workspace",
    icon: "FolderCog",
    keywords: ["pi", "project", "extensions", "settings", "sessions"],
    context: "workspace",
    onSelect: (context) => open(context, { tab: "extensions", cwd: context.workspace.directory }),
  });

  client.addSlashCommand({
    name: "workflow",
    description: "Run, approve, or control Pi Rust workflows",
    argumentHint: "[run <name> key=value… [--worktree[=branch]] | approve [id] [run|skip|stop] | stop|resume|skip <id> | runs | edit <name>]",
    context: "agent",
    async onSubmit(context) {
      const { args, agent, workspace, rpc, openPanel } = context;
      const cwd = workspace.directory;
      const command = parseWorkflowCommand(args);
      switch (command.kind) {
        case "open":
        case "new":
          openPanel(PANEL_ID);
          return;
        case "runs":
          open(context, { tab: "runs" });
          return;
        case "status":
          open(context, command.id ? { run: command.id } : { tab: "runs" });
          return;
        case "edit": {
          const { workflows } = await rpc(workflowsListRpc, { cwd });
          const found = workflows.find((workflow) => workflow.name === command.name);
          if (!found) throw new Error(`No workflow ${command.name}. ${WORKFLOW_USAGE}`);
          open(context, { tab: "workflows", edit: found.name, scope: found.source, cwd });
          return;
        }
        case "run": {
          const { workflows } = await rpc(workflowsListRpc, { cwd });
          const found = workflows.find((workflow) => workflow.name === command.name);
          if (!found) throw new Error(`No workflow ${command.name}.`);
          if (found.askModels.length > 0) {
            openPanel(PANEL_ID);
            throw new Error(`${found.name} asks for models when it starts. Run it from the Workflows panel.`);
          }
          const missing = found.inputs.filter((input) => !command.inputs[input]?.trim());
          if (missing.length > 0) {
            throw new Error(`${found.name} needs ${missing.map((input) => `${input}="…"`).join(" ")}.`);
          }
          let runCwd = cwd;
          if (command.worktree) {
            // A fresh Paseo worktree of this project; the workflow still comes from this workspace.
            const created = await createWorktree(context.paseo, {
              projectId: workspace.projectId,
              projectRoot: workspace.projectRootPath,
              branchName: command.worktree.branch ?? undefined,
              title: `${found.name} run`,
            });
            runCwd = created.directory;
          }
          await rpc(runStartRpc, {
            name: found.name,
            source: found.source,
            definitionCwd: runCwd !== cwd && found.source === "project" ? cwd : undefined,
            cwd: runCwd,
            inputs: command.inputs,
            background: command.background,
            agentId: agent.id,
            origin: "user",
          });
          return;
        }
        case "approve": {
          const id = command.id ?? (await waitingRun(rpc, cwd));
          await rpc(runControlRpc, { id, action: "approve", decision: command.decision });
          return;
        }
        case "control":
          await rpc(runControlRpc, { id: command.id, action: command.action });
          return;
      }
    },
  });

  client.addSlashCommand({
    name: "pi-ext",
    description: "Install, remove, enable, disable, or update Pi Rust extensions",
    argumentHint: "[install|remove|enable|disable|update <source> [-l]]",
    context: "workspace",
    async onSubmit(context) {
      const command = parseExtensionCommand(context.args);
      if (command.kind === "open") {
        open(context, { tab: "extensions", cwd: context.workspace.directory });
        return;
      }
      const result = await context.rpc(extensionsRunRpc, {
        action: command.action,
        target: command.target,
        scope: command.project ? "project" : "global",
        cwd: context.workspace.directory,
      });
      if (!result.ok) throw new Error(result.output.split("\n").slice(-4).join("\n") || `pi exited with ${result.code}. ${EXTENSION_USAGE}`);
      open(context, { tab: "extensions", cwd: command.project ? context.workspace.directory : undefined });
    },
  });

  // The Pi Rust pill in each agent's composer: background tasks, runs, goals, and timers.
  const stopPills = startStatusPills(client);

  return () => {
    stopPills();
    setClient(null);
  };
}
