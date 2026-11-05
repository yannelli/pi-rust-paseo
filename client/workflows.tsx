// Saved workflows of a workspace: list as pipelines, create, edit, copy, delete, and run. In a
// worktree it also offers the workflows saved in the main checkout.
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useState } from "react";
import { View } from "react-native";
import { overviewRpc, workflowDeleteRpc, workflowGetRpc, workflowsListRpc, type ScopeName, type WorkflowListItem } from "../shared/contracts";
import { CONTEXT_DESCRIPTIONS, type ContextMode } from "../shared/workflow";
import { WorkflowEditor, type EditorTarget } from "./editor";
import { useRpcMutation, useRpcQuery } from "./queries";
import { RunDialog } from "./run-dialog";
import { RunsList } from "./runs";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  Empty,
  ErrorBox,
  IconButton,
  Notice,
  Row,
  Section,
  Spinner,
  Stack,
  Txt,
  errorMessage,
  shortPath,
  tint,
  useUi,
} from "./ui";
import { useDirInfo, WorkspaceNotices } from "./workspaces";

export interface WorkflowsTabProps {
  /** Workspace directory; empty shows global workflows only. */
  cwd: string;
  /** The Paseo agent whose timeline gets the card of runs started here. */
  agentId?: string;
  onOpenRun: (id: string) => void;
  /** Opens this workflow in the editor on mount. */
  initialEdit?: { name: string; scope: ScopeName } | null;
}

/** Where a listed workflow is saved: this workspace and global, or the main checkout of a worktree. */
interface Origin {
  /** The directory whose `.pi/` holds project workflows of this item; null for global. */
  definitionCwd: string | null;
  fromMain: boolean;
}

interface Editing {
  target: EditorTarget;
  /** The directory the editor saves project workflows into. */
  cwd: string;
}

export function WorkflowsTab({ cwd, agentId, onOpenRun, initialEdit }: WorkflowsTabProps) {
  const [editing, setEditing] = useState<Editing | null>(initialEdit ? { target: { kind: "edit", ...initialEdit }, cwd } : null);
  const [running, setRunning] = useState<{ name: string; source: ScopeName; definitionCwd?: string } | null>(null);
  useEffect(() => {
    if (initialEdit) setEditing({ target: { kind: "edit", ...initialEdit }, cwd });
  }, [initialEdit?.name, initialEdit?.scope]);

  if (editing) {
    return (
      <WorkflowEditor
        key={editing.target.kind === "edit" ? `${editing.cwd}:${editing.target.scope}:${editing.target.name}` : "new"}
        cwd={editing.cwd || undefined}
        target={editing.target}
        onClose={() => setEditing(null)}
        onSaved={(saved) => setEditing({ target: { kind: "edit", name: saved.name, scope: saved.source }, cwd: editing.cwd })}
        onRun={(saved) => {
          setEditing(null);
          setRunning({ ...saved, definitionCwd: saved.source === "project" && editing.cwd !== cwd ? editing.cwd : undefined });
        }}
      />
    );
  }
  return (
    <>
      <WorkflowList
        cwd={cwd}
        onEdit={(target, dir) => setEditing({ target, cwd: dir ?? cwd })}
        onRun={(item, origin) => setRunning({ name: item.name, source: item.source, definitionCwd: origin.fromMain ? (origin.definitionCwd ?? undefined) : undefined })}
        onOpenRun={onOpenRun}
      />
      <RunDialog
        open={running !== null}
        workflow={running ? { name: running.name, source: running.source } : null}
        definitionCwd={running?.definitionCwd}
        cwd={cwd || undefined}
        agentId={agentId}
        onClose={() => setRunning(null)}
        onStarted={onOpenRun}
      />
    </>
  );
}

function WorkflowList({
  cwd,
  onEdit,
  onRun,
  onOpenRun,
}: {
  cwd: string;
  onEdit: (target: EditorTarget, dir?: string) => void;
  onRun: (item: WorkflowListItem, origin: Origin) => void;
  onOpenRun: (id: string) => void;
}) {
  const list = useRpcQuery(workflowsListRpc, { cwd: cwd || undefined }, { refetchInterval: 15_000 });
  const info = useDirInfo(cwd);
  const mainCheckout = info.data?.git?.isWorktree ? info.data.git.mainCheckout : null;
  const mainList = useRpcQuery(workflowsListRpc, { cwd: mainCheckout ?? undefined }, { enabled: Boolean(mainCheckout), staleTime: 15_000 });
  const overview = useRpcQuery(overviewRpc, { cwd: cwd || undefined }, { staleTime: 30_000 });
  const getWorkflow = useRpc(workflowGetRpc);
  const toast = useToast();
  const [deleting, setDeleting] = useState<{ item: WorkflowListItem; dir: string } | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const remove = useRpcMutation(workflowDeleteRpc, { invalidates: ["wf.list", "wf.get"], success: (result) => `Deleted ${shortPath(result.path)}` });

  const workflows = list.data?.workflows ?? [];
  const defaultScope: ScopeName = cwd && list.data?.trusted !== false ? "project" : "global";
  const local = new Set(workflows.filter((w) => w.source === "project").map((w) => w.name));
  const fromMain = (mainList.data?.workflows ?? []).filter((w) => w.source === "project" && !local.has(w.name));

  const copy = async (item: WorkflowListItem, from: string | null, scope: ScopeName) => {
    try {
      const { workflow } = await getWorkflow({ name: item.name, source: item.source, cwd: from ?? (cwd || undefined) });
      onEdit({ kind: "new", scope, draft: { ...workflow, name: from && from !== cwd ? item.name : `${item.name}-copy` } });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const card = (item: WorkflowListItem, origin: Origin) => {
    const key = `${origin.definitionCwd ?? "global"}:${item.source}:${item.name}`;
    return (
      <WorkflowCard
        key={key}
        item={item}
        origin={origin}
        expanded={history === key}
        onRun={() => onRun(item, origin)}
        onEdit={() => onEdit({ kind: "edit", name: item.name, scope: item.source }, origin.definitionCwd ?? undefined)}
        onCopy={() => void copy(item, origin.definitionCwd, origin.fromMain ? "project" : item.source)}
        onDelete={() => setDeleting({ item, dir: origin.definitionCwd ?? cwd })}
        onHistory={() => setHistory(history === key ? null : key)}
        onOpenRun={onOpenRun}
      />
    );
  };

  const project = workflows.filter((w) => w.source === "project");
  const global = workflows.filter((w) => w.source === "global");
  return (
    <Stack gap={24}>
      <Row gap={10} wrap justify="space-between">
        <Button label="New workflow" variant="primary" icon="Plus" onPress={() => onEdit({ kind: "new", scope: defaultScope })} />
        <Row gap={4}>
          <Txt size="xs" tone="muted">
            {list.data ? `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}` : ""}
          </Txt>
          <IconButton icon="RefreshCw" label="Refresh" onPress={() => void list.refetch()} />
        </Row>
      </Row>
      {overview.data && !overview.data.workflows.installed ? (
        <Notice tone="warning" title="The workflows extension is not installed">
          {overview.data.workflows.error ?? "Install marketplace:workflows on the Extensions tab."}
        </Notice>
      ) : null}
      {cwd ? <WorkspaceNotices cwd={cwd} what="project workflows" /> : null}
      {list.error ? <ErrorBox error={list.error} /> : null}
      {list.isLoading ? <Spinner label="Reading workflows" /> : null}
      {(list.data?.errors ?? []).map((error) => (
        <ErrorBox key={error} title="Unreadable workflow file" error={error} />
      ))}
      {list.data && workflows.length === 0 && fromMain.length === 0 ? (
        <Card>
          <Empty
            icon="Workflow"
            title="No workflows yet"
            body="A workflow is a list of steps. One pi agent runs each step with its own model, tools, skills, and MCP servers; tasks can wait, repeat, loop until a goal, or wait for your approval."
            action={<Button label="Create a workflow" variant="primary" icon="Plus" onPress={() => onEdit({ kind: "new", scope: defaultScope })} />}
          />
        </Card>
      ) : null}
      {project.length > 0 ? (
        <Section title="This workspace" description="Saved in this workspace's .pi folder.">
          <Stack gap={10}>{project.map((item) => card(item, { definitionCwd: cwd, fromMain: false }))}</Stack>
        </Section>
      ) : null}
      {fromMain.length > 0 && mainCheckout ? (
        <Section title="From the main checkout" description={`Saved in ${mainCheckout}. Runs here use this worktree as their directory.`}>
          <Stack gap={10}>{fromMain.map((item) => card(item, { definitionCwd: mainCheckout, fromMain: true }))}</Stack>
        </Section>
      ) : null}
      {global.length > 0 ? (
        <Section title="Global" description="Every workspace can run these.">
          <Stack gap={10}>{global.map((item) => card(item, { definitionCwd: null, fromMain: false }))}</Stack>
        </Section>
      ) : null}
      <ConfirmModal
        open={deleting !== null}
        title="Delete workflow"
        body={`Delete the ${deleting?.item.source === "global" ? "global" : "project"} workflow ${deleting?.item.name}? Its runs stay in the run history.`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate({ name: deleting.item.name, scope: deleting.item.source, cwd: deleting.dir || undefined });
          setDeleting(null);
        }}
      />
    </Stack>
  );
}

function modelName(model: string | null): string | null {
  if (!model) return null;
  if (model === "ask") return "asks";
  return model.split("/").pop() ?? model;
}

/** The steps as a pipeline: numbered nodes with their model and markers for approvals, loops, and waits. */
function Pipeline({ steps }: { steps: WorkflowListItem["steps"] }) {
  const { theme } = useUi();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 8, columnGap: 6 }}>
      {steps.map((step, index) => (
        <Fragment key={`${index}-${step.name}`}>
          {index > 0 ? <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} /> : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingLeft: 4,
              paddingRight: 9,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <View style={{ width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: tint(theme.colors.accent, 0.55) }}>
              <Txt size="xs" weight="700" style={{ lineHeight: 14 }}>
                {String(index + 1)}
              </Txt>
            </View>
            <Txt size="sm" weight="500" numberOfLines={1}>
              {step.name}
            </Txt>
            {modelName(step.model) ? (
              <Txt size="xs" tone="muted" numberOfLines={1}>
                {modelName(step.model)}
              </Txt>
            ) : null}
            {step.approval ? <Icon name="Hand" size={12} color={theme.colors.statusWarning} /> : null}
            {step.loop ? <Icon name="Repeat" size={12} color={theme.colors.foregroundMuted} /> : null}
            {step.wait ? <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} /> : null}
          </View>
        </Fragment>
      ))}
    </View>
  );
}

function WorkflowCard({
  item,
  origin,
  expanded,
  onRun,
  onEdit,
  onCopy,
  onDelete,
  onHistory,
  onOpenRun,
}: {
  item: WorkflowListItem;
  origin: Origin;
  expanded: boolean;
  onRun: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onOpenRun: (id: string) => void;
}) {
  const { theme, compact } = useUi();
  const broken = item.problems.length > 0;
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: compact ? "column" : "row", gap: 12, alignItems: compact ? "stretch" : "flex-start" }}>
        <Row gap={12} align="flex-start" style={{ flex: 1 }}>
          <View style={{ width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: tint(theme.colors.accent, 0.22) }}>
            <Icon name={item.mode === "dynamic" ? "Sparkles" : "Workflow"} size={17} color={theme.colors.foreground} />
          </View>
          <Stack gap={4} style={{ flex: 1 }}>
            <Row gap={6} wrap>
              <Txt size="lg" weight="600">
                {item.name}
              </Txt>
              {origin.fromMain ? <Badge label="main checkout" icon="GitBranch" /> : <Badge label={item.source === "global" ? "global" : "workspace"} icon={item.source === "global" ? "Globe" : "FolderGit2"} />}
              {item.mode === "dynamic" ? <Badge label="dynamic" tone="accent" icon="Sparkles" /> : null}
              {item.background ? <Badge label="background" icon="MoonStar" /> : null}
              {item.askModels.length > 0 ? <Badge label="asks for models" tone="warning" /> : null}
              {broken ? <Badge label="invalid" tone="danger" icon="CircleAlert" /> : null}
            </Row>
            {item.description ? (
              <Txt size="sm" tone="muted" numberOfLines={2}>
                {item.description}
              </Txt>
            ) : null}
          </Stack>
        </Row>
        <Row gap={2} justify={compact ? "flex-end" : undefined}>
          <IconButton icon="Pencil" label={`Edit ${item.name}`} onPress={onEdit} />
          <IconButton icon={origin.fromMain ? "CopyPlus" : "Copy"} label={origin.fromMain ? `Copy ${item.name} to this worktree` : `Copy ${item.name}`} onPress={onCopy} />
          <IconButton icon="History" label={`Runs of ${item.name}`} tone={expanded ? "default" : "muted"} onPress={onHistory} />
          {origin.fromMain ? null : <IconButton icon="Trash2" label={`Delete ${item.name}`} tone="danger" onPress={onDelete} />}
          <View style={{ width: 6 }} />
          <Button small variant="primary" icon="Play" label={origin.fromMain ? "Run here" : "Run"} disabled={broken} onPress={onRun} />
        </Row>
      </View>
      {item.steps.length > 0 ? <Pipeline steps={item.steps} /> : <Txt size="sm" tone="muted">The planner writes the steps when the run starts.</Txt>}
      <Row gap={10} wrap>
        <Txt size="xs" tone="muted">
          {`${item.taskCount} task${item.taskCount === 1 ? "" : "s"} · ${CONTEXT_DESCRIPTIONS[item.context as ContextMode] ?? item.context}`}
        </Txt>
        {item.inputs.length > 0 ? (
          <Row gap={4} wrap>
            {item.inputs.map((input) => (
              <Badge key={input} label={`{{${input}}}`} tone="accent" />
            ))}
          </Row>
        ) : null}
      </Row>
      {item.problems.map((problem) => (
        <Txt key={problem} size="xs" tone="danger">
          {`• ${problem}`}
        </Txt>
      ))}
      {expanded ? (
        <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12 }}>
          <RunsList workflow={item.name} limit={10} onOpen={onOpenRun} />
        </View>
      ) : null}
    </Card>
  );
}
