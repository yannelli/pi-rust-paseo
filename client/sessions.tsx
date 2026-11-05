// pi's saved sessions, by workspace: list, delete, and prune.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { sessionsListRpc, sessionsPruneRpc, sessionsRemoveRpc, type CommandResult } from "../shared/contracts";
import { useRpcMutation, useRpcQuery } from "./queries";
import {
  Badge,
  Button,
  Card,
  Chips,
  CodeBlock,
  ConfirmModal,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Row,
  Section,
  Spinner,
  Stack,
  Txt,
  relativeTime,
  tint,
  useUi,
} from "./ui";
import { WorkspaceChip } from "./workspaces";

type Session = ReturnType<typeof useSessions>["sessions"][number];

function useSessions(cwd: string, everywhere: boolean) {
  const list = useRpcQuery(sessionsListRpc, { cwd: cwd || undefined, all: everywhere, limit: 200 }, { staleTime: 15_000 });
  return { list, sessions: list.data?.sessions ?? [] };
}

export function SessionsTab({ cwd }: { cwd: string }) {
  const { theme } = useUi();
  const [all, setAll] = useState(!cwd);
  const everywhere = all || !cwd;
  const { list, sessions: raw } = useSessions(cwd, everywhere);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [olderThan, setOlderThan] = useState("30d");
  const [result, setResult] = useState<CommandResult | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const remove = useRpcMutation(sessionsRemoveRpc, {
    invalidates: ["pi.sessions.list", "pi.stats"],
    success: (out) => (out.ok ? "Deleted the sessions" : null),
    onSuccess: (out) => {
      if (!out.ok) setResult(out);
      setSelected([]);
    },
  });
  const prune = useRpcMutation(sessionsPruneRpc, { invalidates: ["pi.sessions.list", "pi.stats"], onSuccess: setResult });
  const sessions = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return raw.filter((s) => !words || `${s.name ?? ""} ${s.firstMessage} ${s.cwd} ${s.shortId}`.toLowerCase().includes(words));
  }, [raw, filter]);
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) map.set(session.cwd, [...(map.get(session.cwd) ?? []), session]);
    return [...map.entries()];
  }, [sessions]);
  const toggle = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const validDuration = /^\d+[smhdw]$/.test(olderThan.trim());
  return (
    <Stack gap={24}>
      <Row gap={10} wrap justify="space-between">
        {cwd ? (
          <Chips
            options={[
              { label: "This workspace", value: "project" },
              { label: "Every workspace", value: "all" },
            ]}
            value={everywhere ? "all" : "project"}
            onChange={(value) => setAll(value === "all")}
          />
        ) : (
          <Txt size="sm" tone="muted">
            Every workspace. Choose one at the top to see only its sessions.
          </Txt>
        )}
        <Row gap={6}>
          {selected.length > 0 ? <Button small variant="danger" icon="Trash2" label={`Delete ${selected.length}`} busy={remove.isPending} onPress={() => setConfirm(true)} /> : null}
          <IconButton icon="RefreshCw" label="Refresh" onPress={() => void list.refetch()} />
        </Row>
      </Row>

      <Field value={filter} onChangeText={setFilter} placeholder={`Search ${raw.length} sessions by name, first prompt, directory, or id`} />
      {list.isLoading ? <Spinner label="Reading sessions" /> : null}
      {list.error ? <ErrorBox error={list.error} /> : null}
      {list.data && sessions.length === 0 ? (
        <Card>
          <Empty icon="History" title="No sessions" body={filter ? "Nothing matches the search." : "pi saves a session file for each conversation."} />
        </Card>
      ) : null}
      {groups.map(([dir, items]) => (
        <Stack key={dir} gap={8}>
          {everywhere ? <WorkspaceChip dir={dir} /> : null}
          <Card padded={false} style={{ gap: 0 }}>
            {items.map((session, index) => {
              const picked = selected.includes(session.id);
              return (
                <Pressable
                  key={session.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: picked }}
                  accessibilityLabel={`Session ${session.shortId}`}
                  onPress={() => toggle(session.id)}
                  style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderTopWidth: index ? 1 : 0,
                    borderColor: theme.colors.border,
                    backgroundColor: picked ? tint(theme.colors.statusDanger, 0.08) : hovered ? theme.colors.surface2 : "transparent",
                  })}
                >
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      borderWidth: 1.5,
                      borderColor: picked ? theme.colors.statusDanger : tint(theme.colors.foregroundMuted, 0.6),
                      backgroundColor: picked ? theme.colors.statusDanger : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {picked ? <Icon name="Check" size={11} color={theme.colors.surface0} /> : null}
                  </View>
                  <Stack gap={1} style={{ flex: 1 }}>
                    <Txt size="sm" weight="500" numberOfLines={1}>
                      {session.name ?? (session.firstMessage.replace(/<[^>]+>/g, " ").split("\n").find((line) => line.trim()) || "(empty)")}
                    </Txt>
                    <Txt size="xs" tone="muted" numberOfLines={1}>
                      {`${session.shortId} · ${session.messageCount} messages · $${session.cost.toFixed(2)}`}
                    </Txt>
                  </Stack>
                  <Txt size="xs" tone="muted">
                    {relativeTime(session.modified ? Date.parse(session.modified) : null)}
                  </Txt>
                </Pressable>
              );
            })}
          </Card>
        </Stack>
      ))}

      <Section title="Prune" description={`Delete sessions with no activity for a while${everywhere ? " in every workspace" : " in this workspace"}.`}>
        <Card>
          <Row gap={8} wrap align="flex-end">
            <View style={{ width: 150 }}>
              <Field label="Older than" value={olderThan} onChangeText={setOlderThan} placeholder="30d" error={validDuration ? null : "such as 30d, 12h, 2w"} />
            </View>
            <Button label="Preview" variant="outline" disabled={!validDuration} busy={prune.isPending && prune.variables?.dryRun} onPress={() => prune.mutate({ cwd: cwd || undefined, all: everywhere, olderThan: olderThan.trim(), dryRun: true })} />
            <Button label="Prune" variant="danger" disabled={!validDuration} busy={prune.isPending && !prune.variables?.dryRun} onPress={() => setConfirmPrune(true)} />
            {result ? <Badge label={result.ok ? "done" : `failed (exit ${result.code})`} tone={result.ok ? "success" : "danger"} /> : null}
          </Row>
          {result ? <CodeBlock text={result.output || (result.ok ? "Nothing to prune." : `exit ${result.code}`)} maxHeight={200} /> : null}
        </Card>
      </Section>

      <ConfirmModal
        open={confirm}
        title="Delete sessions"
        body={`Delete ${selected.length} session file${selected.length === 1 ? "" : "s"}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          remove.mutate({ cwd: cwd || undefined, all: everywhere, ids: selected });
          setConfirm(false);
        }}
      />
      <ConfirmModal
        open={confirmPrune}
        title="Prune sessions"
        body={`Delete every session with no activity for ${olderThan}${everywhere ? " in every workspace" : " in this workspace"}? Preview first to see the list.`}
        confirmLabel="Prune"
        danger
        onClose={() => setConfirmPrune(false)}
        onConfirm={() => {
          prune.mutate({ cwd: cwd || undefined, all: everywhere, olderThan: olderThan.trim(), dryRun: false });
          setConfirmPrune(false);
        }}
      />
    </Stack>
  );
}
