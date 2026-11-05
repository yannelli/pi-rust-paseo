// Starts a run of a saved workflow: where it runs (this workspace, another one, or a new
// worktree), models marked `ask`, the `{{inputs}}`, and background or foreground.
import { usePaseo, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { modelsRpc, pluginSettings, runStartRpc, workflowGetRpc, type ScopeName } from "../shared/contracts";
import { ASK, askModels, DEFAULT_MODEL, parseWorkflow, workflowInputs, type Workflow } from "../shared/workflow";
import { useRpcMutation, useRpcQuery } from "./queries";
import { Badge, Button, Chips, ErrorBox, Field, Row, Spinner, Stack, Toggle, Txt, UiModal, errorMessage, shortPath, tint, useUi } from "./ui";
import { WorkspaceChip, WorkspaceNotices, WorkspacePicker, createWorktree, useWorkspaceIndex, type ProjectInfo } from "./workspaces";

const INHERIT = "__inherit";
const OTHER = "__other";

type Where = "here" | "other" | "worktree";

/** The default model, then the models the workflow names, then the first models pi lists. */
function suggestedModels(workflow: Workflow | null, listed: readonly string[]): string[] {
  const out: string[] = [];
  const add = (model: string | undefined) => {
    if (model && model !== ASK && !out.includes(model)) out.push(model);
  };
  add(DEFAULT_MODEL);
  add(workflow?.agent?.model);
  for (const step of workflow?.steps ?? []) add(step.agent?.model);
  for (const model of listed) {
    if (out.length >= 5) break;
    add(model);
  }
  return out.slice(0, 5);
}

function ModelChoice({ label, value, onChange, suggestions, models }: { label: string; value: string; onChange: (value: string) => void; suggestions: readonly string[]; models: readonly string[] }) {
  const chip = !value ? INHERIT : suggestions.includes(value) ? value : OTHER;
  const needle = value.trim().toLowerCase();
  const matches = chip === OTHER && needle ? models.filter((model) => model !== value && model.toLowerCase().includes(needle)).slice(0, 6) : [];
  return (
    <Stack gap={8}>
      <Chips
        label={label}
        options={[{ label: "Inherit", value: INHERIT }, ...suggestions.map((model) => ({ label: model, value: model })), { label: "Other", value: OTHER }]}
        value={chip}
        onChange={(next: string) => {
          if (next === INHERIT) onChange("");
          else if (next === OTHER) onChange(chip === OTHER ? value : " ");
          else onChange(next);
        }}
      />
      {chip === OTHER ? (
        <Field value={value.trimStart()} onChangeText={onChange} placeholder="provider/model-id" mono hint="Empty inherits the workflow default or the session model." />
      ) : null}
      {matches.length ? (
        <Row gap={4} wrap>
          {matches.map((model) => (
            <Button key={model} small variant="ghost" label={model} onPress={() => onChange(model)} />
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}

/** A labeled block of the dialog: a small heading, then its controls. */
function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Stack gap={10}>
      <Stack gap={2}>
        <Txt size="sm" weight="600">
          {title}
        </Txt>
        {hint ? (
          <Txt size="xs" tone="muted">
            {hint}
          </Txt>
        ) : null}
      </Stack>
      {children}
    </Stack>
  );
}

/** A radio-like card: icon, title, subtitle, and the controls it reveals when chosen. */
function OptionCard({ icon, title, subtitle, selected, onPress, children }: { icon: string; title: string; subtitle?: ReactNode; selected: boolean; onPress: () => void; children?: ReactNode }) {
  const { theme } = useUi();
  return (
    <View
      style={{
        borderWidth: 1,
        borderRadius: 10,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? tint(theme.colors.accent, 0.08) : theme.colors.surface1,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={title}
        onPress={onPress}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 12,
          backgroundColor: !selected && hovered ? theme.colors.surface2 : "transparent",
        })}
      >
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: selected ? tint(theme.colors.accent, 0.35) : theme.colors.surface2,
          }}
        >
          <Icon name={icon} size={15} color={selected ? theme.colors.foreground : theme.colors.foregroundMuted} />
        </View>
        <Stack gap={2} style={{ flex: 1 }}>
          <Txt size="sm" weight="600">
            {title}
          </Txt>
          {typeof subtitle === "string" ? (
            <Txt size="xs" tone="muted" numberOfLines={1}>
              {subtitle}
            </Txt>
          ) : (
            subtitle
          )}
        </Stack>
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            borderWidth: selected ? 5 : 1.5,
            borderColor: selected ? theme.colors.accent : theme.colors.foregroundMuted,
          }}
        />
      </Pressable>
      {selected && children ? <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>{children}</View> : null}
    </View>
  );
}

/** The project a new worktree branches off: the chosen one, and a filterable list to change it. */
function ProjectChoice({ projects, value, onChange }: { projects: readonly ProjectInfo[]; value: ProjectInfo | null; onChange: (id: string) => void }) {
  const { theme } = useUi();
  const [changing, setChanging] = useState(value === null);
  const [filter, setFilter] = useState("");
  const words = filter.trim().toLowerCase();
  const matches = projects.filter((project) => !words || `${project.name} ${project.root}`.toLowerCase().includes(words));
  const shown = matches.slice(0, 16);
  return (
    <Stack gap={8}>
      <Row gap={10} style={{ padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border }}>
        <Icon name="FolderGit2" size={15} color={theme.colors.foregroundMuted} />
        <Stack gap={0} style={{ flex: 1 }}>
          <Txt size="sm" weight="600" numberOfLines={1}>
            {value ? value.name : "Choose a project"}
          </Txt>
          {value ? (
            <Txt size="xs" tone="muted" mono numberOfLines={1}>
              {value.root}
            </Txt>
          ) : null}
        </Stack>
        {projects.length > 1 ? <Button small variant="ghost" label={changing ? "Done" : "Change"} onPress={() => setChanging(!changing)} /> : null}
      </Row>
      {changing ? (
        <Stack gap={8}>
          {projects.length > 8 ? <Field value={filter} onChangeText={setFilter} placeholder={`Filter ${projects.length} projects`} /> : null}
          <Chips
            options={shown.map((project) => ({ label: project.name, value: project.id }))}
            value={value?.id}
            onChange={(id: string) => {
              onChange(id);
              setChanging(false);
              setFilter("");
            }}
          />
          {matches.length > shown.length ? (
            <Txt size="xs" tone="muted">
              {`${matches.length - shown.length} more; type to filter.`}
            </Txt>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function RunDialog({
  open,
  onClose,
  workflow: target,
  cwd,
  definitionCwd,
  agentId,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  workflow: { name: string; source: ScopeName } | null;
  cwd?: string;
  /** Where the saved project workflow lives, when that is not `cwd` (a worktree running its main checkout's workflow). */
  definitionCwd?: string;
  agentId?: string;
  onStarted?: (runId: string) => void;
}) {
  const { theme, compact } = useUi();
  const visible = open && target !== null;
  const sourceDir = definitionCwd ?? cwd;
  const definition = useRpcQuery(
    workflowGetRpc,
    { name: target?.name ?? "", source: target?.source, cwd: sourceDir },
    { enabled: visible },
  );
  const modelList = useRpcQuery(modelsRpc, {}, { enabled: visible, staleTime: 300_000 });
  const settings = useSettings(pluginSettings);
  const index = useWorkspaceIndex();
  const paseo = usePaseo();
  const queries = useQueryClient();

  const parsed = useMemo(() => (definition.data ? parseWorkflow(definition.data.workflow) : null), [definition.data]);
  const workflow = parsed?.ok ? parsed.workflow : null;
  const inputs = useMemo(() => (workflow ? workflowInputs(workflow) : []), [workflow]);
  const asks = useMemo(() => (workflow ? askModels(workflow) : []), [workflow]);
  const listed = useMemo(() => (modelList.data?.models ?? []).map((model) => `${model.provider}/${model.id}`), [modelList.data]);
  const suggestions = useMemo(() => suggestedModels(workflow, listed), [workflow, listed]);
  const contextProject = index.find(cwd).project;

  const [where, setWhere] = useState<Where>(cwd ? "here" : "other");
  const [otherDir, setOtherDir] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [background, setBackground] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; cause: unknown } | null>(null);

  // A fresh form each time the dialog opens for a workflow.
  useEffect(() => {
    if (!visible) return;
    setWhere(cwd ? "here" : "other");
    setOtherDir("");
    setProjectId(null);
    setBranch("");
    setBase("");
    setTitle("");
    setValues({});
    setModels({});
    setBackground(null);
    setPhase(null);
    setError(null);
  }, [visible, target?.name, target?.source, cwd]);

  const project = index.projects.find((p) => p.id === (projectId ?? contextProject?.id)) ?? null;
  const defaultBackground = settings.status === "ready" ? settings.values.defaultBackground : true;
  const runInBackground = background ?? (Boolean(workflow?.background) || defaultBackground);
  const runDir = where === "here" ? (cwd ?? "") : where === "other" ? otherDir : "";

  const start = useRpcMutation(runStartRpc, { invalidates: ["runs.list"], success: (result) => `Started ${result.id}`, toastErrors: false });

  const missing = inputs.filter((name) => !(values[name] ?? "").trim());
  const placeReady = where === "worktree" ? Boolean(project) : runDir.trim().length > 0;
  const busy = phase !== null;
  const ready = Boolean(workflow) && placeReady && missing.length === 0 && !busy;

  async function submit() {
    if (!target || !workflow || !ready) return;
    setError(null);
    const chosen: Record<string, string | null> = {};
    for (const ask of asks) {
      const value = (models[String(ask.target)] ?? "").trim();
      chosen[String(ask.target)] = value.length ? value : null;
    }
    const trimmed: Record<string, string> = {};
    for (const name of inputs) trimmed[name] = (values[name] ?? "").trim();
    let failure = "The run did not start";
    try {
      let dir = runDir.trim();
      if (where === "worktree" && project) {
        failure = "Paseo could not create the worktree";
        setPhase("Creating worktree…");
        const created = await createWorktree(paseo, {
          projectId: project.id,
          projectRoot: project.root,
          branchName: branch.trim() || undefined,
          baseBranch: base.trim() || undefined,
          title: title.trim() || `${target.name} run`,
        });
        dir = created.directory;
        void queries.invalidateQueries({ queryKey: ["paseo.workspaces"] });
      }
      failure = "The run did not start";
      setPhase("Starting run…");
      const result = await start.mutateAsync({
        name: target.name,
        source: target.source,
        definitionCwd: sourceDir,
        cwd: dir,
        inputs: trimmed,
        models: chosen,
        background: runInBackground,
        agentId,
        origin: "user",
      });
      setPhase(null);
      onStarted?.(result.id);
      onClose();
    } catch (cause) {
      setPhase(null);
      setError({ title: failure, cause });
    }
  }

  const twoColumns = !compact && inputs.length + asks.length > 0;

  return (
    <UiModal
      title={target ? `Run ${target.name}` : "Run workflow"}
      open={visible}
      onClose={() => {
        if (!busy) onClose();
      }}
      contentContainerStyle={{ gap: 22 }}
    >
      {definition.isLoading ? <Spinner label="Reading the workflow…" /> : null}
      {definition.error ? <ErrorBox title="Cannot read the workflow" error={definition.error} /> : null}
      {parsed && !parsed.ok ? <ErrorBox title="The workflow is not valid" error={parsed.error} /> : null}
      {workflow ? (
        <>
          <Stack gap={8}>
            <Row gap={6} wrap>
              <Badge label={target?.source === "project" ? "project" : "global"} icon={target?.source === "project" ? "FolderGit2" : "Globe"} />
              <Badge label={workflow.mode ?? "fixed"} tone={workflow.mode === "dynamic" ? "accent" : "muted"} />
              <Badge label={`${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"}`} icon="ListOrdered" />
              {workflow.context && workflow.context !== "handoff" ? <Badge label={`context: ${workflow.context}`} /> : null}
            </Row>
            {workflow.description ? (
              <Txt size="sm" tone="muted" numberOfLines={3}>
                {workflow.description}
              </Txt>
            ) : null}
          </Stack>

          <Block title="Where" hint="Step agents work in this directory and read its .pi folder.">
            {cwd ? (
              <OptionCard icon="MapPin" title="This workspace" subtitle={<WorkspaceChip dir={cwd} open={false} />} selected={where === "here"} onPress={() => setWhere("here")} />
            ) : null}
            <OptionCard
              icon="FolderSearch"
              title="Another workspace"
              subtitle={where === "other" && otherDir ? <WorkspaceChip dir={otherDir} open={false} /> : "Pick a workspace or a directory"}
              selected={where === "other"}
              onPress={() => setWhere("other")}
            >
              <WorkspacePicker value={otherDir} onChange={setOtherDir} maxHeight={260} />
            </OptionCard>
            <OptionCard
              icon="GitBranchPlus"
              title="New worktree"
              subtitle={project ? `Branch off ${project.name} in a new Paseo workspace` : "Branch off a project in a new Paseo workspace"}
              selected={where === "worktree"}
              onPress={() => setWhere("worktree")}
            >
              <ProjectChoice key={contextProject?.id ?? "none"} projects={index.projects} value={project} onChange={setProjectId} />
              <View style={{ flexDirection: compact ? "column" : "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Field label="Branch" value={branch} onChangeText={setBranch} placeholder="Paseo names the branch" mono />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Base" value={base} onChangeText={setBase} placeholder="The project's default branch" mono />
                </View>
              </View>
              <Field label="Workspace title" value={title} onChangeText={setTitle} placeholder={`${target?.name ?? "workflow"} run`} />
            </OptionCard>
            {where !== "worktree" && runDir ? <WorkspaceNotices cwd={runDir} what="project skills, settings, and extensions" /> : null}
          </Block>

          <View style={{ flexDirection: twoColumns ? "row" : "column", gap: 22, alignItems: "flex-start" }}>
            {asks.length > 0 ? (
              <View style={{ flex: twoColumns ? 1 : undefined, alignSelf: "stretch" }}>
                <Block title="Models" hint="The workflow asks for these when it starts. Inherit uses the workflow default, else pi's default model.">
                  {asks.map((ask) => (
                    <ModelChoice
                      key={ask.target}
                      label={ask.label}
                      value={models[String(ask.target)] ?? ""}
                      onChange={(value) => setModels((current) => ({ ...current, [String(ask.target)]: value }))}
                      suggestions={suggestions}
                      models={listed}
                    />
                  ))}
                </Block>
              </View>
            ) : null}
            {inputs.length > 0 ? (
              <View style={{ flex: twoColumns ? 1 : undefined, alignSelf: "stretch" }}>
                <Block title="Inputs" hint="Values for the {{placeholders}} of the prompts.">
                  {inputs.map((name) => (
                    <Field
                      key={name}
                      label={name === "goal" ? "Goal: what must the workflow reach?" : name}
                      value={values[name] ?? ""}
                      onChangeText={(text) => setValues((current) => ({ ...current, [name]: text }))}
                      placeholder={`{{${name}}}`}
                      multiline
                      minHeight={64}
                    />
                  ))}
                </Block>
              </View>
            ) : null}
          </View>

          <Block title="Options">
            <Toggle
              label="Run in the background"
              hint="Background runs keep going when the plugin stops; foreground runs stop as interrupted and can resume."
              value={runInBackground}
              onChange={setBackground}
            />
          </Block>

          {error ? <ErrorBox title={error.title} error={errorMessage(error.cause)} /> : null}

          <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 14, flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 10 }}>
            <View style={{ flex: compact ? undefined : 1 }}>
              {phase ? (
                <Row gap={6}>
                  <Icon name="LoaderCircle" size={14} color={theme.colors.foregroundMuted} />
                  <Txt size="sm" tone="muted">
                    {phase}
                  </Txt>
                </Row>
              ) : missing.length ? (
                <Txt size="xs" tone="muted">
                  {`Needs ${missing.join(", ")}`}
                </Txt>
              ) : !placeReady ? (
                <Txt size="xs" tone="muted">
                  {where === "worktree" ? "Choose a project." : "Choose where to run."}
                </Txt>
              ) : (
                <Txt size="xs" tone="muted" numberOfLines={1}>
                  {where === "worktree" ? `Runs in a new worktree of ${project?.name ?? "the project"}` : `Runs in ${shortPath(runDir)}`}
                </Txt>
              )}
            </View>
            <Row gap={8} justify="flex-end">
              <Button label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
              <Button label={where === "worktree" ? "Create and run" : "Run"} icon="Play" variant="primary" busy={busy} disabled={!ready} onPress={() => void submit()} />
            </Row>
          </View>
        </>
      ) : null}
    </UiModal>
  );
}
