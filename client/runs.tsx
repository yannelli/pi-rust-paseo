// The list of workflow runs, grouped by what needs attention, and helpers the run view and card share.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { runControlRpc, runsListRpc } from "../shared/contracts";
import { costLabel, isActive, statusLabel, type Decision, type RunStatus, type RunSummary, type StepStatus } from "../shared/runs";
import { formatDuration } from "../shared/workflow";
import { useRpcMutation, useRpcQuery } from "./queries";
import { WorkspaceChip } from "./workspaces";
import { Button, Chips, Empty, ErrorBox, Row, Spinner, Stack, StatusDot, Txt, relativeTime, runTone, tint, toneColor, useUi, type Tone } from "./ui";

/** The current time, refreshed each second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function useRunControl() {
  return useRpcMutation(runControlRpc, {
    invalidates: ["runs.list", "runs.get"],
    success: (result) => result.message,
  });
}

/** A tinted pill with a status dot that pulses while the run works. */
export function RunStatusBadge({ status, stale, large, approval }: { status: RunStatus; stale: boolean; large?: boolean; approval?: boolean }) {
  const { theme } = useUi();
  const waitsForYou = Boolean(approval) && isActive(status) && !stale;
  const tone: Tone = waitsForYou ? "warning" : runTone(status, stale);
  const neutral = tone === "muted";
  const color = neutral ? theme.colors.foregroundMuted : tone === "accent" ? theme.colors.foreground : toneColor(theme, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        paddingLeft: 2,
        paddingRight: large ? 9 : 7,
        height: large ? 24 : 20,
        borderRadius: 6,
        alignSelf: "flex-start",
        backgroundColor: neutral ? theme.colors.surface2 : tint(toneColor(theme, tone), tone === "accent" ? 0.4 : 0.16),
      }}
    >
      <StatusDot tone={tone === "accent" ? "success" : tone} pulse={status === "running" && !stale && !waitsForYou} size={6} />
      <Txt size={large ? "sm" : "xs"} weight="600" style={{ color }}>
        {waitsForYou ? "needs approval" : statusLabel(status, stale)}
      </Txt>
    </View>
  );
}

/** `12m4s` from start to end, or to `now` while the run goes on. */
export function elapsedLabel(startedMs: number, endedMs: number | null, now: number): string {
  if (!startedMs) return "";
  return formatDuration(((endedMs ?? now) - startedMs) / 1000);
}

/** Time left of a wait, or null when the run does not wait. */
export function waitLeft(waitUntilMs: number | null, now: number): string | null {
  if (waitUntilMs == null) return null;
  return formatDuration(Math.max(0, waitUntilMs - now) / 1000);
}

/** Approve, skip, or stop at the task that waits for approval. */
export function ApprovalButtons({ id, small }: { id: string; small?: boolean }) {
  const control = useRunControl();
  const answer = (decision: Decision) => control.mutate({ id, action: "approve", decision });
  const pending = control.isPending ? control.variables?.decision : undefined;
  return (
    <Row gap={6} wrap>
      <Button small={small} variant="primary" icon="Check" label="Approve" busy={pending === "run"} disabled={control.isPending} onPress={() => answer("run")} />
      <Button small={small} variant="outline" icon="SkipForward" label="Skip task" busy={pending === "skip"} disabled={control.isPending} onPress={() => answer("skip")} />
      <Button small={small} variant="danger" icon="Square" label="Stop run" busy={pending === "stop"} disabled={control.isPending} onPress={() => answer("stop")} />
    </Row>
  );
}

/**
 * Segments for the steps: done in the success color, the current one in the run's color, a
 * failed one in the danger color. `steps` gives each step's status when it is known.
 */
export function StepBar({
  run,
  steps,
  height = 4,
}: {
  run: Pick<RunSummary, "stepCount" | "stepsDone" | "currentStep" | "status" | "stale"> & { approval?: RunSummary["approval"] };
  steps?: readonly { status: StepStatus }[];
  height?: number;
}) {
  const { theme } = useUi();
  if (run.stepCount === 0) return null;
  const tone = run.approval && isActive(run.status) && !run.stale ? "warning" : runTone(run.status, run.stale);
  const currentColor = tone === "accent" ? theme.colors.accent : toneColor(theme, tone);
  return (
    <Row gap={3}>
      {Array.from({ length: run.stepCount }, (_, index) => {
        const status = steps?.[index]?.status;
        const done = status ? status === "done" : index < run.stepsDone;
        const failed = status === "failed";
        const current = !done && !failed && index === run.currentStep && run.status !== "done";
        const color = done ? theme.colors.statusSuccess : failed ? theme.colors.statusDanger : current ? currentColor : theme.colors.surface2;
        return <View key={index} style={{ flex: 1, height, borderRadius: height / 2, backgroundColor: color }} />;
      })}
    </Row>
  );
}

type Filter = "all" | "active" | "approval" | "finished";

function live(run: RunSummary): boolean {
  return isActive(run.status) && !run.stale;
}

function needsYou(run: RunSummary): boolean {
  return live(run) && run.approval !== null;
}

function matches(run: RunSummary, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return live(run);
    case "approval":
      return needsYou(run);
    case "finished":
      return !live(run);
  }
}

export function RunsList({
  cwd,
  workflow,
  onOpen,
  limit,
  scopeToggle,
}: {
  cwd?: string;
  workflow?: string;
  onOpen: (id: string) => void;
  limit?: number;
  /** With `cwd`: let the user switch between this workspace's runs and every run. */
  scopeToggle?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<"here" | "all">("here");
  const [anyActive, setAnyActive] = useState(false);
  const queryCwd = cwd && (!scopeToggle || scope === "here") ? cwd : undefined;
  const query = useRpcQuery(runsListRpc, { cwd: queryCwd, workflow, limit }, { refetchInterval: anyActive ? 1000 : 5000 });
  const runs = query.data?.runs;
  useEffect(() => {
    setAnyActive(Boolean(runs?.some(live)));
  }, [runs]);
  const now = useNow(anyActive);
  const all = runs ?? [];
  const counts = useMemo(
    () => ({
      all: all.length,
      active: all.filter(live).length,
      approval: all.filter(needsYou).length,
      finished: all.filter((run) => !live(run)).length,
    }),
    [all],
  );
  const visible = useMemo(() => all.filter((run) => matches(run, filter)), [all, filter]);

  const label = (text: string, count: number) => (count ? `${text} · ${count}` : text);
  const header = (
    <Row gap={8} wrap justify="space-between">
      <Chips
        options={[
          { label: label("All", counts.all), value: "all" as const },
          { label: label("Active", counts.active), value: "active" as const },
          { label: label("Needs approval", counts.approval), value: "approval" as const },
          { label: label("Finished", counts.finished), value: "finished" as const },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {cwd && scopeToggle ? (
        <Chips
          options={[
            { label: "This workspace", value: "here" as const },
            { label: "All workspaces", value: "all" as const },
          ]}
          value={scope}
          onChange={setScope}
        />
      ) : null}
    </Row>
  );

  if (query.isPending) {
    return (
      <Stack gap={12}>
        {header}
        <Spinner label="Loading runs" />
      </Stack>
    );
  }
  if (query.isError) return <ErrorBox title="Cannot read the runs" error={query.error} />;

  if (visible.length === 0) {
    return (
      <Stack gap={12}>
        {header}
        {all.length === 0 ? (
          <Empty
            icon="Workflow"
            title={queryCwd ? "No runs in this workspace" : "No runs yet"}
            body="Runs appear here when you start a workflow from the Workflows tab, from pi's /workflows, or when an agent runs one with its workflow tool."
          />
        ) : (
          <Empty icon="ListFilter" title="No runs match this filter" />
        )}
      </Stack>
    );
  }

  const attention = filter === "all" ? visible.filter(needsYou) : filter === "approval" ? visible : [];
  const active = filter === "all" || filter === "active" ? visible.filter((run) => live(run) && !needsYou(run)) : [];
  const finished = filter === "all" || filter === "finished" ? visible.filter((run) => !live(run)) : [];
  const activeOnly = filter === "active" ? visible.filter(needsYou) : [];

  return (
    <Stack gap={18}>
      {header}
      {attention.length ? (
        <Group title="Needs you" count={attention.length} tone="warning">
          <Stack gap={8}>
            {attention.map((run) => (
              <ApprovalCard key={run.id} run={run} onOpen={onOpen} />
            ))}
          </Stack>
        </Group>
      ) : null}
      {active.length || activeOnly.length ? (
        <Group title="Active" count={active.length + activeOnly.length}>
          <RowList runs={[...activeOnly, ...active]} now={now} onOpen={onOpen} />
        </Group>
      ) : null}
      {finished.length ? (
        <Group title="Finished" count={finished.length}>
          <RowList runs={finished} now={now} onOpen={onOpen} />
        </Group>
      ) : null}
    </Stack>
  );
}

function Group({ title, count, tone = "muted", children }: { title: string; count: number; tone?: Tone; children: ReactNode }) {
  return (
    <Stack gap={8}>
      <Row gap={6}>
        <Txt size="sm" weight="600" tone={tone === "muted" ? "default" : tone}>
          {title}
        </Txt>
        <Txt size="sm" tone="muted">
          {count}
        </Txt>
      </Row>
      {children}
    </Stack>
  );
}

function RowList({ runs, now, onOpen }: { runs: RunSummary[]; now: number; onOpen: (id: string) => void }) {
  const { theme } = useUi();
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
      {runs.map((run, index) => (
        <RunRow key={run.id} run={run} now={now} onOpen={onOpen} first={index === 0} />
      ))}
    </View>
  );
}

/** What the run does now, in one line: the wait, the step and its activity, or the error. */
function nowLine(run: RunSummary, now: number): { text: string; tone: Tone; pulse: boolean } | null {
  if (live(run)) {
    const left = waitLeft(run.waitUntilMs, now);
    if (left) return { text: `Next run in ${left}${run.currentStepName ? ` · ${run.currentStepName}` : ""}`, tone: "warning", pulse: false };
    if (run.currentStepName) {
      return { text: run.activity ? `${run.currentStepName} · ${run.activity}` : run.currentStepName, tone: "muted", pulse: Boolean(run.activity) };
    }
    return run.note ? { text: run.note, tone: "muted", pulse: false } : null;
  }
  if (run.error) return { text: run.error, tone: "danger", pulse: false };
  return null;
}

function RunRow({ run, now, onOpen, first }: { run: RunSummary; now: number; onOpen: (id: string) => void; first: boolean }) {
  const { theme, compact } = useUi();
  const line = nowLine(run, now);
  const meta = [elapsedLabel(run.startedMs, run.endedMs, now), costLabel(run.cost), relativeTime(run.startedMs)].filter(Boolean).join(" · ");
  const progress = (
    <Row gap={8} style={{ width: compact ? undefined : 150 }}>
      <View style={{ flex: 1 }}>
        <StepBar run={run} height={3} />
      </View>
      <Txt size="xs" tone="muted" mono>
        {`${run.stepsDone}/${run.stepCount}`}
      </Txt>
    </Row>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open run ${run.id} of ${run.workflow}, ${statusLabel(run.status, run.stale)}`}
      onPress={() => onOpen(run.id)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: compact ? 12 : 16,
        borderTopWidth: first ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <View style={{ paddingTop: 2 }}>
        <StatusDot tone={runTone(run.status, run.stale) === "accent" ? "success" : runTone(run.status, run.stale)} pulse={live(run) && run.status === "running"} />
      </View>
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Row gap={8} justify="space-between" align="flex-start">
          <Row gap={8} style={{ flex: 1, minWidth: 0 }}>
            <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {run.workflow || run.id}
            </Txt>
            <Txt size="sm" tone={runTone(run.status, run.stale) === "accent" ? "muted" : runTone(run.status, run.stale)}>
              {statusLabel(run.status, run.stale)}
            </Txt>
          </Row>
          {compact ? null : (
            <Txt size="xs" tone="muted" numberOfLines={1}>
              {meta}
            </Txt>
          )}
        </Row>
        <Row gap={12} justify="space-between" wrap={compact}>
          <View style={{ flexShrink: 1, minWidth: 0 }}>
            <WorkspaceChip dir={run.cwd} open={false} />
          </View>
          {compact ? null : progress}
        </Row>
        {line ? (
          <Row gap={4}>
            {line.pulse ? <StatusDot tone="success" pulse size={5} /> : null}
            <Txt size="sm" tone={line.tone} numberOfLines={1} style={{ flexShrink: 1 }}>
              {line.text}
            </Txt>
          </Row>
        ) : null}
        {compact ? (
          <Row gap={10} justify="space-between">
            <View style={{ flex: 1 }}>{progress}</View>
            <Txt size="xs" tone="muted" numberOfLines={1}>
              {meta}
            </Txt>
          </Row>
        ) : null}
      </Stack>
    </Pressable>
  );
}

function ApprovalCard({ run, onOpen }: { run: RunSummary; onOpen: (id: string) => void }) {
  const { theme, compact } = useUi();
  const warning = theme.colors.statusWarning;
  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: tint(warning, 0.4), backgroundColor: tint(warning, 0.08), padding: compact ? 12 : 16, gap: 10 }}>
      <Row gap={10} align="flex-start">
        <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: tint(warning, 0.18) }}>
          <Icon name="Hand" size={16} color={warning} />
        </View>
        <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
          <Row gap={6} justify="space-between" align="flex-start">
            <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {`${run.workflow} waits for your approval`}
            </Txt>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open run ${run.id}`} hitSlop={6} onPress={() => onOpen(run.id)}>
              <Row gap={4}>
                <Txt size="sm" tone="muted">
                  Open
                </Txt>
                <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
              </Row>
            </Pressable>
          </Row>
          <Txt size="sm" numberOfLines={2}>
            {`“${run.approval?.task ?? ""}”`}
          </Txt>
          <Row gap={10} wrap>
            <WorkspaceChip dir={run.cwd} open={false} />
            <Txt size="xs" tone="muted">
              {[`step ${(run.approval?.step ?? 0) + 1} of ${run.stepCount}`, `asked ${relativeTime(run.approval?.askedMs)}`].join(" · ")}
            </Txt>
          </Row>
        </Stack>
      </Row>
      <ApprovalButtons id={run.id} small={compact} />
    </View>
  );
}
