// The live card of a workflow run in an agent's timeline.
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { View } from "react-native";
import { runGetRpc, type RunCard } from "../shared/contracts";
import { costLabel, isActive, type RunDetail } from "../shared/runs";
import { openRun } from "./host";
import { useRpcQuery } from "./queries";
import { ApprovalButtons, RunStatusBadge, StepBar, elapsedLabel, useNow, useRunControl, waitLeft } from "./runs";
import { WorkspaceChip } from "./workspaces";
import { Button, ErrorBox, Row, Spinner, Stack, StatusDot, Txt, UiProvider, errorMessage, relativeTime, tint, useUi } from "./ui";

export function RunCardRow(props: PluginTimelineItemProps<RunCard>) {
  return (
    <UiProvider theme={props.theme} compact={props.layout.compact}>
      <RunCardBody runId={props.item.data.runId} workflow={props.item.data.workflow} />
    </UiProvider>
  );
}

function live(run: RunDetail): boolean {
  return isActive(run.status) && !run.stale;
}

function Frame({ workflow, right, children }: { workflow: string; right?: ReactNode; children?: ReactNode }) {
  const { theme, compact } = useUi();
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, padding: compact ? 12 : 14, gap: 10 }}>
      <Row gap={8} justify="space-between" align="flex-start">
        <Row gap={8} style={{ flex: 1, minWidth: 0 }}>
          <View style={{ width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
            <Icon name="Workflow" size={15} color={theme.colors.foregroundMuted} />
          </View>
          <Stack gap={0} style={{ flexShrink: 1, minWidth: 0 }}>
            <Txt size="xs" tone="muted">
              Workflow run
            </Txt>
            <Txt weight="600" numberOfLines={1}>
              {workflow}
            </Txt>
          </Stack>
        </Row>
        {right}
      </Row>
      {children}
    </View>
  );
}

function RunCardBody({ runId, workflow }: { runId: string; workflow: string }) {
  const { theme } = useUi();
  const query = useRpcQuery(
    runGetRpc,
    { id: runId },
    {
      refetchInterval: (state) => {
        const run = state.state.data?.run;
        return run && live(run) ? 2000 : false;
      },
    },
  );
  const run = query.data?.run;
  const active = run ? live(run) : false;
  const now = useNow(active);
  const control = useRunControl();

  if (query.isPending) {
    return (
      <Frame workflow={workflow}>
        <Spinner />
      </Frame>
    );
  }
  if (query.isError || !run) {
    const message = errorMessage(query.error);
    return (
      <Frame workflow={workflow}>
        {message.includes("No run") ? <Txt size="sm" tone="muted">{`Run ${runId} was deleted.`}</Txt> : <ErrorBox error={query.error} />}
      </Frame>
    );
  }

  const cost = costLabel(run.cost);
  const left = active ? waitLeft(run.waitUntilMs, now) : null;
  const warning = theme.colors.statusWarning;
  const meta = [`${run.stepsDone}/${run.stepCount} steps`, elapsedLabel(run.startedMs, run.endedMs, now), cost].filter(Boolean).join(" · ");
  return (
    <Frame workflow={run.workflow || workflow} right={<RunStatusBadge status={run.status} stale={run.stale} approval={Boolean(run.approval)} />}>
      <Row gap={10} justify="space-between" wrap>
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <WorkspaceChip dir={run.cwd} open={false} />
        </View>
        <Txt size="xs" tone="muted">
          {meta}
        </Txt>
      </Row>
      <StepBar run={run} steps={run.steps} />
      {active && run.currentStepName && !run.approval && !left ? (
        <Row gap={6}>
          {run.activity ? <StatusDot tone="success" pulse size={5} /> : null}
          <Txt size="sm" numberOfLines={1} style={{ flexShrink: 1 }}>
            <Txt size="sm" weight="600">
              {run.currentStepName}
            </Txt>
            <Txt size="sm" tone="muted">{run.activity ? ` · ${run.activity}` : ""}</Txt>
          </Txt>
        </Row>
      ) : null}
      {left ? (
        <Row gap={6}>
          <Icon name="Hourglass" size={13} color={theme.colors.foregroundMuted} />
          <Txt size="sm" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {`Next run in ${left}${run.currentStepName ? ` · ${run.currentStepName}` : ""}`}
          </Txt>
        </Row>
      ) : null}
      {run.error ? (
        <Txt size="sm" tone="danger" numberOfLines={3}>
          {run.error}
        </Txt>
      ) : null}
      {active && run.approval ? (
        <View style={{ borderRadius: 10, borderWidth: 1, borderColor: tint(warning, 0.4), backgroundColor: tint(warning, 0.08), padding: 10, gap: 8 }}>
          <Row gap={8} align="flex-start">
            <Icon name="Hand" size={14} color={warning} />
            <Stack gap={1} style={{ flex: 1 }}>
              <Txt size="sm" weight="600" tone="warning">
                Waits for your approval
              </Txt>
              <Txt size="sm" numberOfLines={2}>{`“${run.approval.task}” · asked ${relativeTime(run.approval.askedMs)}`}</Txt>
            </Stack>
          </Row>
          <ApprovalButtons id={run.id} small />
        </View>
      ) : null}
      <Row gap={6} wrap>
        <Button small variant="outline" icon="SquareArrowOutUpRight" label="Open run" onPress={() => openRun(run.id)} />
        {left ? (
          <Button
            small
            variant="outline"
            icon="FastForward"
            label="End wait"
            busy={control.isPending && control.variables?.action === "skip"}
            onPress={() => control.mutate({ id: run.id, action: "skip" })}
          />
        ) : null}
        {active && !run.approval ? (
          <Button
            small
            variant="ghost"
            icon="Square"
            label="Stop"
            busy={control.isPending && control.variables?.action === "stop"}
            onPress={() => control.mutate({ id: run.id, action: "stop" })}
          />
        ) : null}
      </Row>
    </Frame>
  );
}
