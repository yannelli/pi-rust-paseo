// One workflow run, live: a stepper of its steps, the selected step's agent transcript,
// approvals, waits, messages to the working agent, and run control.
import { copyText, Icon, Markdown, StreamedText, useToast } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { runFilesRpc, runGetRpc, runOutputRpc, runSteerRpc } from "../shared/contracts";
import { costLabel, isActive, type OutputEntry, type RunDetail, type StepRun, type StepStatus } from "../shared/runs";
import { formatDuration } from "../shared/workflow";
import { poll, useRpcMutation, useRpcQuery } from "./queries";
import { ApprovalButtons, RunStatusBadge, StepBar, elapsedLabel, useNow, useRunControl, waitLeft } from "./runs";
import { WorkspaceChip } from "./workspaces";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  Empty,
  ErrorBox,
  Field,
  KeyValue,
  Notice,
  Row,
  Spinner,
  Stack,
  StatusDot,
  TabBar,
  Txt,
  errorMessage,
  relativeTime,
  tint,
  toneColor,
  useUi,
  type Tone,
} from "./ui";

/** The step the user picked, or null to follow the current step. */
type PickedStep = number | null;

type DetailTab = "output" | "report" | "memory" | "log" | "definition" | "inputs";

const DETAIL_TABS: readonly { id: DetailTab; label: string; icon: string }[] = [
  { id: "output", label: "Output", icon: "TerminalSquare" },
  { id: "report", label: "Report", icon: "FileText" },
  { id: "memory", label: "Memory", icon: "NotebookPen" },
  { id: "log", label: "Log", icon: "ScrollText" },
  { id: "definition", label: "Definition", icon: "Braces" },
  { id: "inputs", label: "Inputs", icon: "TextCursorInput" },
];

function stepTone(status: StepStatus): Tone {
  return ({ pending: "muted", running: "accent", done: "success", failed: "danger" } as const)[status];
}

function live(run: RunDetail): boolean {
  return isActive(run.status) && !run.stale;
}

/** `claude-opus-5-5` from `anthropic/claude-opus-5-5`. */
function shortModel(model: string | null): string {
  if (!model) return "";
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function RunView({ id, onBack }: { id: string; onBack?: () => void }) {
  const { compact } = useUi();
  const query = useRpcQuery(
    runGetRpc,
    { id },
    {
      refetchInterval: (state) => {
        const run = state.state.data?.run;
        return run && live(run) ? 1000 : false;
      },
    },
  );
  const run = query.data?.run;
  const active = run ? live(run) : false;
  const now = useNow(active);
  const [picked, setPicked] = useState<PickedStep>(null);
  const [tab, setTab] = useState<DetailTab>("output");

  if (query.isPending) return <Spinner label="Loading the run" />;
  if (query.isError || !run) {
    const missing = errorMessage(query.error).includes("No run");
    return (
      <Stack gap={12}>
        {onBack ? <BackLink onBack={onBack} /> : null}
        {missing ? <Empty icon="Trash2" title={`Run ${id} was deleted.`} /> : <ErrorBox title="Cannot read the run" error={query.error} />}
      </Stack>
    );
  }

  const followed = run.agentStep ?? run.currentStep ?? 0;
  const selected = Math.min(picked ?? followed, Math.max(0, run.steps.length - 1));
  const step = run.steps[selected];
  const following = picked === null || picked === followed;

  const timeline = (
    <Stack gap={10} style={compact ? undefined : { width: 300 }}>
      <Row justify="space-between">
        <Row gap={6}>
          <Txt size="sm" weight="600">
            Steps
          </Txt>
          <Txt size="sm" tone="muted">{`${run.stepsDone} of ${run.stepCount} done`}</Txt>
        </Row>
        {!following ? <Button small variant="ghost" label="Follow current" icon="Crosshair" onPress={() => setPicked(null)} /> : null}
      </Row>
      {run.steps.length === 0 ? (
        <Txt size="sm" tone="muted">
          {run.mode === "dynamic" ? "The planner has not written any steps yet." : "This workflow has no steps."}
        </Txt>
      ) : (
        <View>
          {run.steps.map((item, index) => (
            <StepItem
              key={`${index}-${item.name}`}
              step={item}
              index={index}
              last={index === run.steps.length - 1}
              now={now}
              live={active}
              waiting={active && run.approval?.step === index}
              selected={index === selected}
              onPress={() => setPicked(index)}
            />
          ))}
        </View>
      )}
    </Stack>
  );

  const detailTabs = step ? DETAIL_TABS : DETAIL_TABS.filter((t) => t.id !== "output" && t.id !== "report");
  const shownTab = step || (tab !== "output" && tab !== "report") ? tab : "memory";
  const detail = (
    <Card padded={false} style={{ flex: 1, minWidth: 0, gap: 0 }}>
      {step ? <StepHeader step={step} index={selected} now={now} /> : null}
      <View style={{ paddingHorizontal: compact ? 8 : 12 }}>
        <TabBar tabs={detailTabs} value={shownTab} onChange={setTab} />
      </View>
      <View style={{ padding: compact ? 12 : 16 }}>
        <StepDetail run={run} step={step ?? null} index={selected} tab={shownTab} />
      </View>
      {active && run.agentStep !== null && shownTab === "output" ? <SteerBox id={run.id} stepName={run.steps[run.agentStep]?.name ?? ""} /> : null}
    </Card>
  );

  return (
    <Stack gap={16}>
      {onBack ? <BackLink onBack={onBack} /> : null}
      <RunHeader run={run} now={now} onBack={onBack} />
      {active && run.approval ? <ApprovalBanner run={run} /> : null}
      {active && run.waitUntilMs != null ? <WaitBanner run={run} now={now} /> : null}
      {run.error ? <ErrorBox title={run.status === "failed" ? "The run failed" : "Error"} error={run.error} /> : null}
      {run.note && !run.approval && !(active && run.waitUntilMs != null) ? <Notice tone="muted">{run.note}</Notice> : null}
      {compact ? (
        <Stack gap={16}>
          {timeline}
          {detail}
        </Stack>
      ) : (
        <Row gap={20} align="flex-start">
          {timeline}
          {detail}
        </Row>
      )}
    </Stack>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  const { theme } = useUi();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back to runs" onPress={onBack} hitSlop={6} style={{ alignSelf: "flex-start" }}>
      <Row gap={4}>
        <Icon name="ArrowLeft" size={14} color={theme.colors.foregroundMuted} />
        <Txt size="sm" tone="muted">
          All runs
        </Txt>
      </Row>
    </Pressable>
  );
}

function MetaItem({ icon, children }: { icon: string; children: ReactNode }) {
  const { theme } = useUi();
  return (
    <Row gap={5}>
      <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
      {typeof children === "string" ? (
        <Txt size="sm" tone="muted" numberOfLines={1}>
          {children}
        </Txt>
      ) : (
        children
      )}
    </Row>
  );
}

function RunHeader({ run, now, onBack }: { run: RunDetail; now: number; onBack?: () => void }) {
  const toast = useToast();
  const { compact, theme } = useUi();
  const cost = costLabel(run.cost);
  const model = run.parentModel ? `${shortModel(run.parentModel)}${run.parentThinking ? ` · ${run.parentThinking}` : ""}` : null;
  const startedBy = run.paseoAgentId ? "a Paseo agent" : run.origin === "agent" ? "an agent" : "you";
  const owner = run.ownedHere ? "Owned by this plugin" : run.owner ? `Owned by pi ${run.owner}` : null;
  const title = (
    <Stack gap={8} style={{ flex: 1, minWidth: 0 }}>
      <Row gap={10} wrap>
        <Txt size={compact ? "lg" : "xl"} weight="700" numberOfLines={1} style={{ flexShrink: 1 }}>
          {run.workflow || run.id}
        </Txt>
        <RunStatusBadge status={run.status} stale={run.stale} approval={Boolean(run.approval)} large />
        {run.mode === "dynamic" ? <Badge label="dynamic" tone="accent" icon="Sparkles" /> : null}
      </Row>
      <WorkspaceChip dir={run.cwd} size="md" />
      {run.description ? (
        <Txt size="sm" tone="muted" numberOfLines={2}>
          {run.description}
        </Txt>
      ) : null}
    </Stack>
  );
  return (
    <Card style={{ gap: 12 }}>
      {compact ? (
        <Stack gap={12}>
          {title}
          <RunActions run={run} onBack={onBack} />
        </Stack>
      ) : (
        <Row justify="space-between" align="flex-start" gap={16}>
          {title}
          <RunActions run={run} onBack={onBack} />
        </Row>
      )}
      <StepBar run={run} steps={run.steps} />
      <Row gap={compact ? 10 : 18} wrap>
        <MetaItem icon="Timer">{`${elapsedLabel(run.startedMs, run.endedMs, now)}${live(run) ? "" : " total"}`}</MetaItem>
        {cost ? <MetaItem icon="Coins">{cost}</MetaItem> : null}
        <MetaItem icon="CalendarClock">{`Started ${relativeTime(run.startedMs)} by ${startedBy}`}</MetaItem>
        {model ? <MetaItem icon="Cpu">{model}</MetaItem> : null}
        {live(run) ? <MetaItem icon={run.background ? "Layers" : "Pin"}>{run.background ? "Background" : "Foreground"}</MetaItem> : null}
        {owner && live(run) ? <MetaItem icon="Server">{owner}</MetaItem> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy the run id ${run.id}`}
          hitSlop={4}
          onPress={() =>
            void copyText(run.id).then(
              () => toast.show("Copied the run id"),
              (error: unknown) => toast.error(errorMessage(error)),
            )
          }
          style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 6,
            paddingVertical: 1,
            borderRadius: 6,
            backgroundColor: hovered ? theme.colors.surface2 : "transparent",
          })}
        >
          <Txt size="sm" tone="muted" mono>
            {run.id}
          </Txt>
          <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
        </Pressable>
      </Row>
    </Card>
  );
}

function ApprovalBanner({ run }: { run: RunDetail }) {
  const { theme, compact } = useUi();
  const warning = theme.colors.statusWarning;
  const approval = run.approval;
  if (!approval) return null;
  const stepName = run.steps[approval.step]?.name;
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: tint(warning, 0.45), backgroundColor: tint(warning, 0.1), padding: compact ? 14 : 18, gap: 12 }}>
      <Row gap={12} align="flex-start">
        <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: tint(warning, 0.2) }}>
          <Icon name="Hand" size={18} color={warning} />
        </View>
        <Stack gap={4} style={{ flex: 1 }}>
          <Txt size="sm" weight="600" tone="warning">
            Waits for your approval
          </Txt>
          <Txt size="lg" weight="600">{`“${approval.task}”`}</Txt>
          <Txt size="sm" tone="muted">
            {[`Step ${approval.step + 1}${stepName ? ` · ${stepName}` : ""}`, `asked ${relativeTime(approval.askedMs)}`].join(" · ")}
          </Txt>
        </Stack>
      </Row>
      <ApprovalButtons id={run.id} />
    </View>
  );
}

function WaitBanner({ run, now }: { run: RunDetail; now: number }) {
  const { theme, compact } = useUi();
  const control = useRunControl();
  const left = waitLeft(run.waitUntilMs, now);
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: compact ? 14 : 16,
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "flex-start" : "center",
        gap: 12,
      }}
    >
      <Row gap={12} style={{ flex: 1 }}>
        <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
          <Icon name="Hourglass" size={17} color={theme.colors.foregroundMuted} />
        </View>
        <Stack gap={2} style={{ flex: 1 }}>
          <Row gap={8}>
            <Txt size="sm" tone="muted">
              Next run in
            </Txt>
            <Txt size="lg" weight="600" mono>
              {left ?? ""}
            </Txt>
          </Row>
          {run.note ? (
            <Txt size="sm" tone="muted" numberOfLines={2}>
              {run.note}
            </Txt>
          ) : null}
        </Stack>
      </Row>
      <Button variant="outline" icon="FastForward" label="End wait now" busy={control.isPending} onPress={() => control.mutate({ id: run.id, action: "skip" })} />
    </View>
  );
}

function RunActions({ run, onBack }: { run: RunDetail; onBack?: () => void }) {
  const control = useRunControl();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const active = live(run);
  const resumable = run.status !== "done" && (run.stale || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted");
  const deletable = !isActive(run.status) || run.stale;
  const busy = (action: string) => control.isPending && control.variables?.action === action;
  return (
    <Row gap={6} wrap>
      {resumable ? <Button small variant="primary" icon="Play" label="Resume" busy={busy("resume")} onPress={() => control.mutate({ id: run.id, action: "resume" })} /> : null}
      {active ? (
        run.background ? (
          <Button small variant="outline" icon="Pin" label="Bring to foreground" busy={busy("foreground")} onPress={() => control.mutate({ id: run.id, action: "foreground" })} />
        ) : (
          <Button small variant="outline" icon="Layers" label="Send to background" busy={busy("background")} onPress={() => control.mutate({ id: run.id, action: "background" })} />
        )
      ) : null}
      {active ? <Button small variant="danger" icon="Square" label="Stop" busy={busy("stop")} onPress={() => setConfirmStop(true)} /> : null}
      {deletable ? <Button small variant="ghost" icon="Trash2" label="Delete" busy={busy("delete")} onPress={() => setConfirmDelete(true)} /> : null}
      <ConfirmModal
        open={confirmStop}
        title="Stop this run?"
        body={`${run.workflow} stops after its current agent call. A stopped run can resume later at the task that did not finish.`}
        confirmLabel="Stop run"
        danger
        busy={busy("stop")}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => control.mutate({ id: run.id, action: "stop" }, { onSettled: () => setConfirmStop(false) })}
      />
      <ConfirmModal
        open={confirmDelete}
        title="Delete this run?"
        body={`This removes ${run.dir}: its state, the session files of its agents, the shared notes, and the logs. It cannot be undone.`}
        confirmLabel="Delete run"
        danger
        busy={busy("delete")}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          control.mutate(
            { id: run.id, action: "delete" },
            {
              onSuccess: () => {
                setConfirmDelete(false);
                onBack?.();
              },
              onError: () => setConfirmDelete(false),
            },
          )
        }
      />
    </Row>
  );
}

function stepTime(step: StepRun, now: number): string {
  if (!step.startedMs) return "";
  return formatDuration(((step.endedMs ?? now) - step.startedMs) / 1000);
}

/** The circle of a step: a check, a cross, or its number; it pulses while its agent works. */
function StepMarker({ step, index, live, waiting }: { step: StepRun; index: number; live: boolean; waiting: boolean }) {
  const { theme } = useUi();
  const size = 24;
  const running = step.status === "running" && live;
  const tone: Tone = waiting ? "warning" : stepTone(step.status);
  const color = toneColor(theme, tone);
  const background = step.status === "pending" ? theme.colors.surface1 : tone === "accent" ? theme.colors.accent : tint(color, 0.2);
  const border = step.status === "pending" ? theme.colors.border : tone === "accent" ? theme.colors.accent : tint(color, 0.5);
  const fg = tone === "accent" ? theme.colors.accentForeground : step.status === "pending" ? theme.colors.foregroundMuted : color;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {running && !waiting ? (
        <View style={{ position: "absolute", width: size + 8, height: size + 8, borderRadius: (size + 8) / 2, backgroundColor: tint(theme.colors.accent, 0.25) }} />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: border, backgroundColor: background, alignItems: "center", justifyContent: "center" }}>
        {waiting ? (
          <Icon name="Hand" size={12} color={fg} />
        ) : step.status === "done" ? (
          <Icon name="Check" size={13} color={fg} />
        ) : step.status === "failed" ? (
          <Icon name="X" size={13} color={fg} />
        ) : (
          <Txt size="xs" weight="700" style={{ color: fg }}>
            {String(index + 1)}
          </Txt>
        )}
      </View>
    </View>
  );
}

function StepItem({
  step,
  index,
  last,
  now,
  live,
  waiting,
  selected,
  onPress,
}: {
  step: StepRun;
  index: number;
  last: boolean;
  now: number;
  live: boolean;
  waiting: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useUi();
  const meta = [shortModel(step.model), stepTime(step, now), costLabel(step.cost)].filter(Boolean).join(" · ");
  const counts = [step.taskCount ? `tasks ${step.tasksDone}/${step.taskCount}` : "", step.runs > 1 ? `${step.runs} runs` : ""].filter(Boolean).join(" · ");
  const working = live && step.status === "running";
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      <View style={{ width: 24, alignItems: "center" }}>
        <View style={{ paddingTop: 8 }}>
          <StepMarker step={step} index={index} live={live} waiting={waiting} />
        </View>
        {last ? null : <View style={{ flex: 1, width: 2, minHeight: 12, marginVertical: 4, borderRadius: 1, backgroundColor: step.status === "done" ? tint(theme.colors.statusSuccess, 0.5) : theme.colors.border }} />}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`Show step ${index + 1}, ${step.name}, ${step.status}`}
        onPress={onPress}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
          flex: 1,
          minWidth: 0,
          paddingVertical: 8,
          paddingHorizontal: 10,
          marginBottom: last ? 0 : 6,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: selected ? theme.colors.border : "transparent",
          backgroundColor: selected ? theme.colors.surface1 : hovered ? tint(theme.colors.foregroundMuted, 0.08) : "transparent",
          gap: 2,
        })}
      >
        <Row gap={6} justify="space-between">
          <Txt weight={selected ? "600" : "500"} numberOfLines={1} style={{ flexShrink: 1 }} tone={step.status === "pending" ? "muted" : "default"}>
            {step.name}
          </Txt>
          {waiting ? <Badge label="approval" tone="warning" /> : step.status === "failed" ? <Badge label="failed" tone="danger" /> : null}
        </Row>
        {meta ? (
          <Txt size="xs" tone="muted" numberOfLines={1}>
            {meta}
          </Txt>
        ) : null}
        {counts ? (
          <Txt size="xs" tone="muted" numberOfLines={1}>
            {counts}
          </Txt>
        ) : null}
        {working && step.activity ? (
          <Row gap={4} style={{ marginTop: 2 }}>
            <StatusDot tone="success" pulse size={5} />
            <Txt size="xs" numberOfLines={1} style={{ flexShrink: 1 }}>
              {step.activity}
            </Txt>
          </Row>
        ) : null}
      </Pressable>
    </View>
  );
}

function StepHeader({ step, index, now }: { step: StepRun; index: number; now: number }) {
  const { compact, theme } = useUi();
  const details = [
    step.model ?? "",
    stepTime(step, now),
    costLabel(step.cost),
    step.taskCount ? `tasks ${step.tasksDone}/${step.taskCount}` : "",
    step.runs ? `${step.runs} ${step.runs === 1 ? "run" : "runs"} · ${step.turns} turns` : "",
  ].filter(Boolean);
  return (
    <View style={{ paddingHorizontal: compact ? 12 : 16, paddingTop: compact ? 12 : 14, paddingBottom: 4, gap: 4 }}>
      <Row gap={8}>
        <Txt size="sm" tone="muted" mono>
          {String(index + 1).padStart(2, "0")}
        </Txt>
        <Txt size="lg" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
          {step.name}
        </Txt>
        <Badge label={step.status} tone={stepTone(step.status)} />
      </Row>
      {details.length ? (
        <Txt size="xs" tone="muted" numberOfLines={2} style={{ color: theme.colors.foregroundMuted }}>
          {details.join(" · ")}
        </Txt>
      ) : null}
    </View>
  );
}

function StepDetail({ run, step, index, tab }: { run: RunDetail; step: StepRun | null; index: number; tab: DetailTab }) {
  switch (tab) {
    case "output":
      return step ? <StepOutput run={run} step={step} index={index} /> : null;
    case "report":
      return step ? <StepReport step={step} /> : null;
    case "memory":
    case "log":
      return <RunFiles id={run.id} active={live(run)} which={tab} />;
    case "definition":
      return <CodeBlock text={JSON.stringify(run.definition, null, 2)} />;
    case "inputs": {
      const entries = Object.entries(run.inputs);
      if (entries.length === 0) {
        return (
          <Txt size="sm" tone="muted">
            This run has no inputs.
          </Txt>
        );
      }
      return (
        <Stack gap={10}>
          {entries.map(([key, value]) => (
            <KeyValue key={key} label={`{{${key}}}`} value={value} />
          ))}
        </Stack>
      );
    }
  }
}

function StepOutput({ run, step, index }: { run: RunDetail; step: StepRun; index: number }) {
  const running = live(run) && step.status === "running";
  const query = useRpcQuery(runOutputRpc, { id: run.id, step: index, limit: 300 }, { refetchInterval: poll(running, 1500) });
  const { theme } = useUi();
  if (query.isPending) return <Spinner label="Loading the output" />;
  if (query.isError) return <ErrorBox title="Cannot read the output" error={query.error} />;
  const { entries, total } = query.data;
  const empty = entries.length === 0 && !step.writing && !(running && step.activity);
  return (
    <Stack gap={10}>
      {total > entries.length ? <Txt size="xs" tone="muted">{`Showing the last ${entries.length} of ${total} entries.`}</Txt> : null}
      {empty ? (
        <Empty
          icon={step.status === "pending" ? "CircleDashed" : running ? "Loader" : "MessageSquareDashed"}
          title={step.status === "pending" ? "This step has not started yet" : running ? "No output yet" : "No output recorded"}
          body={
            step.status === "pending" || running
              ? undefined
              : "Runs from older versions of the workflows extension keep their output only in the step's session file. The Report tab has its summary."
          }
        />
      ) : null}
      {entries.map((entry, position) => (
        <OutputRow key={position} entry={entry} />
      ))}
      {step.writing && running ? (
        <View style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.accent, paddingLeft: 12, gap: 4 }}>
          <Row gap={4}>
            <StatusDot tone="success" pulse size={5} />
            <Txt size="xs" tone="muted" weight="600">
              Writing
            </Txt>
          </Row>
          <StreamedText text={step.writing} phase="streaming" style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }} />
        </View>
      ) : null}
      {step.activity && running ? (
        <Row gap={6} style={{ paddingVertical: 2 }}>
          <StatusDot tone="success" pulse size={6} />
          <Txt size="sm" mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {step.activity}
          </Txt>
        </Row>
      ) : null}
    </Stack>
  );
}

function PromptCard({ text }: { text: string }) {
  const { theme } = useUi();
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > 6 || text.length > 500;
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 10, padding: 12, gap: 6 }}>
      <Row gap={6} justify="space-between">
        <Row gap={6}>
          <Icon name="ListTodo" size={13} color={theme.colors.foregroundMuted} />
          <Txt size="xs" weight="600" tone="muted">
            Task
          </Txt>
        </Row>
        {long ? (
          <Pressable accessibilityRole="button" accessibilityLabel={open ? "Show less of the task" : "Show the whole task"} onPress={() => setOpen(!open)} hitSlop={6}>
            <Txt size="xs" tone="muted">
              {open ? "Show less" : "Show all"}
            </Txt>
          </Pressable>
        ) : null}
      </Row>
      <Txt size="sm" selectable numberOfLines={open ? undefined : 6}>
        {text}
      </Txt>
    </View>
  );
}

function OutputRow({ entry }: { entry: OutputEntry }) {
  const { theme } = useUi();
  switch (entry.kind) {
    case "prompt":
      return <PromptCard text={entry.text} />;
    case "user":
      return (
        <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: 3, alignItems: "flex-end" }}>
          <Txt size="xs" tone="muted" weight="600">
            You
          </Txt>
          <View style={{ backgroundColor: tint(theme.colors.accent, 0.35), borderRadius: 12, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Txt size="sm" selectable>
              {entry.text}
            </Txt>
          </View>
        </View>
      );
    case "assistant":
      return <Markdown>{entry.text}</Markdown>;
    case "tool": {
      const space = entry.text.indexOf(" ");
      const name = space > 0 ? entry.text.slice(0, space) : entry.text;
      const args = space > 0 ? entry.text.slice(space + 1) : "";
      return (
        <Row gap={8} align="flex-start" style={{ paddingVertical: 2 }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name={name === "bash" ? "Terminal" : "Wrench"} size={12} color={theme.colors.foregroundMuted} />
          </View>
          <Txt size="sm" mono numberOfLines={2} selectable style={{ flex: 1 }}>
            <Txt size="sm" mono weight="600">
              {name}
            </Txt>
            <Txt size="sm" mono tone="muted">{args ? ` ${args}` : ""}</Txt>
          </Txt>
        </Row>
      );
    }
    case "error":
      return <Notice tone="danger">{entry.text}</Notice>;
    default:
      return (
        <Txt size="sm" tone="muted" selectable>
          {entry.text}
        </Txt>
      );
  }
}

function StepReport({ step }: { step: StepRun }) {
  const { theme } = useUi();
  return (
    <Stack gap={14}>
      {step.summary ? (
        <Markdown>{step.summary}</Markdown>
      ) : (
        <Empty icon="FileText" title="No report yet" body="Each agent run of the step ends with a report." />
      )}
      {step.log.length ? (
        <Stack gap={6}>
          <Txt size="sm" weight="600">
            Log
          </Txt>
          {step.log.map((line, position) => (
            <Row key={position} gap={8} align="flex-start">
              <View style={{ width: 4, height: 4, borderRadius: 2, marginTop: 8, backgroundColor: theme.colors.foregroundMuted }} />
              <Txt size="sm" mono selectable style={{ flex: 1 }}>
                {line}
              </Txt>
            </Row>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function RunFiles({ id, active, which }: { id: string; active: boolean; which: "memory" | "log" }) {
  const query = useRpcQuery(runFilesRpc, { id }, { refetchInterval: poll(active, 3000) });
  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (which === "memory") {
    return query.data.memory.trim() ? (
      <Markdown>{query.data.memory}</Markdown>
    ) : (
      <Empty icon="NotebookPen" title="No shared notes" body="Step agents write them with workflow_memory when the workflow context is memory." />
    );
  }
  return query.data.runnerLog.trim() ? (
    <CodeBlock text={query.data.runnerLog} />
  ) : (
    <Empty icon="ScrollText" title="The runner log is empty" body="The runner writes here only when something goes wrong." />
  );
}

function SteerBox({ id, stepName }: { id: string; stepName: string }) {
  const { theme, compact } = useUi();
  const [message, setMessage] = useState("");
  const steer = useRpcMutation(runSteerRpc, {
    success: (result) => result.message,
    onSuccess: () => setMessage(""),
  });
  const send = () => {
    if (message.trim()) steer.mutate({ id, message: message.trim() });
  };
  return (
    <View style={{ borderTopWidth: 1, borderColor: theme.colors.border, padding: compact ? 12 : 16, gap: 6 }}>
      <Row gap={8} align="flex-end">
        <View style={{ flex: 1 }}>
          <Field value={message} onChangeText={setMessage} placeholder={`Message the agent of ${stepName}`} onSubmit={send} />
        </View>
        <Button variant="primary" icon="Send" label="Send" busy={steer.isPending} disabled={!message.trim()} onPress={send} />
      </Row>
      <Txt size="xs" tone="muted">
        The agent reads it after its current tool call.
      </Txt>
    </View>
  );
}

