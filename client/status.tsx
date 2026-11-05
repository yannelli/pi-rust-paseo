// The Pi Rust pill in each agent's composer: a live label and icon for the agent's background
// tasks, workflow runs, goal, and timers, and a popover with their full status.
import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { isActive, statusLabel, type RunSummary } from "../shared/runs";
import {
  agentStatusRpc,
  bgLabel,
  isBad,
  pillLabel,
  pillVisible,
  statusSummaryRpc,
  taskLogRpc,
  taskStopRpc,
  type AgentStatusSummary,
  type BgTask,
  type Goal,
  type Timer,
} from "../shared/status";
import { formatDuration } from "../shared/workflow";
import { piRustIcon } from "./brand";
import { openManager, openRun } from "./host";
import { poll, useRpcMutation, useRpcQuery } from "./queries";
import { ApprovalButtons, useNow } from "./runs";
import {
  Badge,
  BrandMark,
  Button,
  CodeBlock,
  Empty,
  ErrorBox,
  ProgressBar,
  Row,
  Spinner,
  StatusDot,
  Stack,
  Txt,
  UiProvider,
  runTone,
  tint,
  toneColor,
  useUi,
  type Tone,
} from "./ui";
import { WorkspaceChip } from "./workspaces";

// Summaries --------------------------------------------------------------------------------

const summaries = new Map<string, AgentStatusSummary>();
const listeners = new Set<() => void>();

function publish(next: AgentStatusSummary[]) {
  summaries.clear();
  for (const summary of next) summaries.set(summary.agentId, summary);
  for (const listener of listeners) listener();
}

function useSummary(agentId: string): AgentStatusSummary | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => summaries.get(agentId),
  );
}

function summaryTone(summary: AgentStatusSummary | undefined): Tone {
  if (!summary) return "muted";
  if (summary.runs.approvals > 0) return "warning";
  if (summary.tasks.failed > 0) return "danger";
  if (summary.tasks.running > 0 || summary.runs.active > 0 || summary.goal?.status === "active") return "accent";
  return "muted";
}

export function PillIcon(props: PluginButtonIconProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const summary = useSummary(agentId);
  const tone = summaryTone(summary);
  const busy = tone === "accent";
  const name = tone === "warning" ? "Hand" : tone === "danger" ? "CircleAlert" : busy ? "Activity" : null;
  const dot = tone === "accent" ? props.theme.colors.statusSuccess : toneColor(props.theme, tone);
  return (
    <View style={{ width: props.size, height: props.size, alignItems: "center", justifyContent: "center" }}>
      {name ? <Icon name={name} size={props.size} color={tone === "accent" ? props.color : toneColor(props.theme, tone)} /> : <Icon icon={{ svg: piRustIcon }} size={props.size} color={props.color} />}
      {busy || tone === "warning" ? (
        <View style={{ position: "absolute", right: -2, top: -2, width: 7, height: 7, borderRadius: 4, backgroundColor: dot, borderWidth: 1, borderColor: props.theme.colors.surface0 }} />
      ) : null}
    </View>
  );
}

/** Polls the status of every agent and keeps one composer pill per agent that has something to show. */
export function startStatusPills(client: PluginClientContext): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 3000;

  const sync = (agents: AgentStatusSummary[]) => {
    publish(agents);
    const seen = new Set<string>();
    for (const summary of agents) {
      if (!pillVisible(summary)) continue;
      seen.add(summary.agentId);
      const label = pillLabel(summary);
      const title = `Pi Rust: ${label === "Pi Rust" ? "nothing running" : label}`;
      const existing = pills.get(summary.agentId);
      if (existing) {
        // Only presentation changes: updating the behavior would close an open popover.
        if (existing.label !== label) {
          existing.registration.update({ label, title });
          existing.label = label;
        }
        continue;
      }
      try {
        const registration = client.addComposerPill({
          id: "pi-rust-status",
          workspaceId: summary.workspaceId,
          agentId: summary.agentId,
          button: { title, icon: PillIcon, label, behavior: { kind: "popover", Content: StatusPopover } },
        });
        pills.set(summary.agentId, { registration, label });
      } catch (error) {
        console.error("Pi Rust status pill", error);
      }
    }
    for (const [agentId, pill] of pills) {
      if (!seen.has(agentId)) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const { agents } = await client.rpc(statusSummaryRpc, {});
      if (stopped) return;
      sync(agents);
      delay = 3000;
    } catch {
      delay = Math.min(delay * 2, 30_000);
    }
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };
  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
    publish([]);
  };
}

// Popover ----------------------------------------------------------------------------------

export function StatusPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <UiProvider theme={props.theme} compact={props.layout.compact}>
      <AgentStatus agentId={props.agentId} close={props.close} />
    </UiProvider>
  );
}

function since(ms: number | null, now: number): string {
  return ms ? formatDuration((now - ms) / 1000) : "";
}

function SectionTitle({ icon, title, count }: { icon: string; title: string; count?: number }) {
  const { theme } = useUi();
  return (
    <Row gap={6}>
      <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
      <Txt size="xs" weight="600" tone="muted" style={{ letterSpacing: 0.4 }}>
        {title.toUpperCase()}
      </Txt>
      {count ? (
        <Txt size="xs" tone="muted">
          {String(count)}
        </Txt>
      ) : null}
    </Row>
  );
}

function List({ children }: { children: ReactNode }) {
  const { theme } = useUi();
  return <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>{children}</View>;
}

function AgentStatus({ agentId, close }: { agentId: string; close: () => void }) {
  const { compact } = useUi();
  const status = useRpcQuery(agentStatusRpc, { agentId }, { refetchInterval: 1500 });
  const now = useNow(true);
  const data = status.data;
  const approvals = (data?.runs ?? []).filter((run) => isActive(run.status) && !run.stale && run.approval);
  const empty = data && data.tasks.length === 0 && data.runs.length === 0 && data.goals.length === 0 && data.timers.length === 0;
  return (
    <View style={{ width: compact ? undefined : 420, gap: 16 }}>
      <Row justify="space-between">
        <Row gap={8}>
          <BrandMark size={18} />
          <Txt weight="600">Pi Rust</Txt>
          {data?.agent.sessionId ? (
            <Txt size="xs" tone="muted" mono>
              {data.agent.sessionId.slice(0, 10)}
            </Txt>
          ) : null}
        </Row>
        <Button
          small
          variant="ghost"
          icon="ArrowUpRight"
          label="Open"
          onPress={() => {
            close();
            openManager({ tab: "runs", cwd: data?.agent.cwd });
          }}
        />
      </Row>
      {data?.agent.cwd ? <WorkspaceChip dir={data.agent.cwd} open={false} /> : null}
      {status.isLoading ? <Spinner /> : null}
      {status.error ? <ErrorBox error={status.error} /> : null}
      {approvals.map((run) => (
        <View key={run.id} style={{ gap: 8 }}>
          <Approval run={run} />
        </View>
      ))}
      {data && data.tasks.length > 0 && data.agent.sessionId ? <Tasks tasks={data.tasks} sessionId={data.agent.sessionId} now={now} /> : null}
      {data && data.runs.length > 0 ? <Runs runs={data.runs} now={now} close={close} /> : null}
      {data && data.goals.length > 0 ? <Goals goals={data.goals} now={now} /> : null}
      {data && data.timers.length > 0 ? <Timers timers={data.timers} now={now} /> : null}
      {empty ? (
        <Empty
          icon="Coffee"
          title="Nothing running"
          body={data?.agent.isPi ? "Background tasks, workflow runs, goals, and timers of this pi session show here." : "Workflow runs in this workspace show here."}
        />
      ) : null}
    </View>
  );
}

function Approval({ run }: { run: RunSummary }) {
  const { theme } = useUi();
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 10, backgroundColor: tint(theme.colors.statusWarning, 0.12), borderWidth: 1, borderColor: tint(theme.colors.statusWarning, 0.4) }}>
      <Row gap={8}>
        <Icon name="Hand" size={15} color={theme.colors.statusWarning} />
        <Txt size="sm" weight="600" style={{ flex: 1 }}>
          {`${run.workflow} waits for your approval`}
        </Txt>
      </Row>
      <Txt size="sm" tone="muted">{`“${run.approval?.task ?? ""}”`}</Txt>
      <ApprovalButtons id={run.id} small />
    </View>
  );
}

function taskTone(task: BgTask): Tone {
  if (task.status === "running") return "accent";
  if (isBad(task.status)) return "danger";
  return task.status === "completed" ? "success" : "muted";
}

function Tasks({ tasks, sessionId, now }: { tasks: BgTask[]; sessionId: string; now: number }) {
  const { theme } = useUi();
  const [open, setOpen] = useState<string | null>(tasks.find((t) => t.status === "running")?.id ?? null);
  const running = tasks.filter((t) => t.status === "running").length;
  const shown = tasks.slice(0, 8);
  return (
    <Stack gap={8}>
      <SectionTitle icon="SquareTerminal" title={running ? `Background tasks · ${running} running` : "Background tasks"} />
      <List>
        {shown.map((task, index) => {
          const expanded = open === task.id;
          const tone = taskTone(task);
          const time = task.status === "running" ? since(task.startedAt, now) : task.endedAt && task.startedAt ? formatDuration((task.endedAt - task.startedAt) / 1000) : "";
          return (
            <View key={task.id} style={{ borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${task.name}, ${bgLabel(task.status)}`}
                onPress={() => setOpen(expanded ? null : task.id)}
                style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ padding: 10, gap: 3, backgroundColor: hovered ? theme.colors.surface2 : "transparent" })}
              >
                <Row gap={8}>
                  <StatusDot tone={tone} pulse={task.status === "running"} size={7} />
                  <Txt size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                    {task.name}
                  </Txt>
                  <Badge label={task.exitCode !== null && task.status === "failed" ? `exit ${task.exitCode}` : bgLabel(task.status)} tone={tone === "accent" ? "accent" : tone} />
                  <Txt size="xs" tone="muted">
                    {time}
                  </Txt>
                  <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
                </Row>
                {task.description ? (
                  <Txt size="xs" tone="muted" numberOfLines={expanded ? undefined : 1} style={{ paddingLeft: 22 }}>
                    {task.description}
                  </Txt>
                ) : null}
              </Pressable>
              {expanded ? <TaskDetail task={task} sessionId={sessionId} /> : null}
            </View>
          );
        })}
      </List>
      {tasks.length > shown.length ? (
        <Txt size="xs" tone="muted">
          {`${tasks.length - shown.length} older tasks not shown`}
        </Txt>
      ) : null}
    </Stack>
  );
}

function TaskDetail({ task, sessionId }: { task: BgTask; sessionId: string }) {
  const running = task.status === "running";
  const log = useRpcQuery(taskLogRpc, { sessionId, taskId: task.id, maxBytes: 6000 }, { refetchInterval: poll(running, 2000) });
  const [confirm, setConfirm] = useState(false);
  const stop = useRpcMutation(taskStopRpc, { invalidates: ["status.agent", "status.summary"], success: (out) => out.message });
  return (
    <Stack gap={8} style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
      <CodeBlock text={`$ ${task.command}`} maxHeight={66} />
      {task.error ? (
        <Txt size="xs" tone="danger">
          {task.error}
        </Txt>
      ) : null}
      {log.data?.text ? <CodeBlock text={log.data.truncated ? `…\n${log.data.text}` : log.data.text} maxHeight={200} /> : log.isLoading ? null : <Txt size="xs" tone="muted">No output yet.</Txt>}
      <Row justify="space-between">
        <Txt size="xs" tone="muted">
          {`${task.id}${task.timeoutSeconds ? ` · times out after ${formatDuration(task.timeoutSeconds)}` : ""}`}
        </Txt>
        {running ? (
          <Button
            small
            variant="danger"
            icon="Square"
            label={confirm ? "Confirm stop" : "Stop"}
            busy={stop.isPending}
            onPress={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              stop.mutate({ sessionId, taskId: task.id });
            }}
          />
        ) : null}
      </Row>
    </Stack>
  );
}

function Runs({ runs, now, close }: { runs: RunSummary[]; now: number; close: () => void }) {
  const { theme } = useUi();
  return (
    <Stack gap={8}>
      <SectionTitle icon="Workflow" title="Workflow runs" />
      <List>
        {runs.map((run, index) => {
          const live = isActive(run.status) && !run.stale;
          return (
            <Pressable
              key={run.id}
              accessibilityRole="button"
              accessibilityLabel={`Open run ${run.workflow}`}
              onPress={() => {
                close();
                openRun(run.id);
              }}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
                padding: 10,
                gap: 6,
                borderTopWidth: index ? 1 : 0,
                borderColor: theme.colors.border,
                backgroundColor: hovered ? theme.colors.surface2 : "transparent",
              })}
            >
              <Row gap={8}>
                <StatusDot tone={runTone(run.status, run.stale)} pulse={run.status === "running" && !run.stale} size={7} />
                <Txt size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                  {run.workflow}
                </Txt>
                <Txt size="xs" tone={run.status === "running" && !run.stale ? "muted" : runTone(run.status, run.stale)}>
                  {statusLabel(run.status, run.stale)}
                </Txt>
                <Txt size="xs" tone="muted">
                  {since(run.startedMs, live ? now : (run.endedMs ?? now)) || ""}
                </Txt>
              </Row>
              <ProgressBar value={run.stepCount ? run.stepsDone / run.stepCount : 0} tone={runTone(run.status, run.stale)} height={3} />
              {live && (run.activity || run.currentStepName) ? (
                <Txt size="xs" tone="muted" numberOfLines={1}>
                  {[run.currentStepName, run.activity].filter(Boolean).join(" · ")}
                </Txt>
              ) : null}
            </Pressable>
          );
        })}
      </List>
    </Stack>
  );
}

function Goals({ goals, now }: { goals: Goal[]; now: number }) {
  const tone = (goal: Goal): Tone => (goal.status === "active" || goal.status === "auditing" ? "accent" : goal.status === "blocked" ? "danger" : "warning");
  return (
    <Stack gap={8}>
      <SectionTitle icon="Target" title="Goal" />
      {goals.slice(0, 2).map((goal) => (
        <List key={goal.id}>
          <Stack gap={6} style={{ padding: 10 }}>
            <Row gap={8} align="flex-start">
              <Txt size="sm" weight="600" style={{ flex: 1 }} numberOfLines={3}>
                {goal.title}
              </Txt>
              <Badge label={goal.status.replace(/_/g, " ")} tone={tone(goal)} />
            </Row>
            {goal.taskCount ? (
              <Row gap={8}>
                <View style={{ flex: 1 }}>
                  <ProgressBar value={goal.tasksDone / goal.taskCount} tone={tone(goal)} />
                </View>
                <Txt size="xs" tone="muted">{`${goal.tasksDone}/${goal.taskCount} tasks`}</Txt>
              </Row>
            ) : null}
            {goal.currentTask ? (
              <Txt size="xs" tone="muted" numberOfLines={2}>
                {`Now: ${goal.currentTask}`}
              </Txt>
            ) : null}
            {goal.waitReason ? (
              <Txt size="xs" tone="warning" numberOfLines={2}>
                {`Waits${goal.waitUntil && goal.waitUntil > now ? ` ${formatDuration((goal.waitUntil - now) / 1000)}` : ""}: ${goal.waitReason}`}
              </Txt>
            ) : null}
          </Stack>
        </List>
      ))}
    </Stack>
  );
}

function Timers({ timers, now }: { timers: Timer[]; now: number }) {
  const { theme } = useUi();
  return (
    <Stack gap={8}>
      <SectionTitle icon="AlarmClock" title="Timers" count={timers.length} />
      <List>
        {timers.map((timer, index) => (
          <Row key={timer.id} gap={8} style={{ padding: 10, borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
            <Icon name={timer.kind === "heartbeat" ? "HeartPulse" : "CalendarClock"} size={14} color={theme.colors.foregroundMuted} />
            <Stack gap={0} style={{ flex: 1 }}>
              <Txt size="sm" weight="500" numberOfLines={1}>
                {timer.label}
              </Txt>
              <Txt size="xs" tone="muted" numberOfLines={1}>
                {`${timer.detail}${timer.max ? ` · ${timer.count}/${timer.max}` : timer.count ? ` · ${timer.count} so far` : ""}`}
              </Txt>
            </Stack>
            {timer.nextAt ? (
              <Txt size="xs" tone="muted">
                {timer.nextAt > now ? `in ${formatDuration((timer.nextAt - now) / 1000)}` : "due"}
              </Txt>
            ) : null}
          </Row>
        ))}
      </List>
    </Stack>
  );
}
