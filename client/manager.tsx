// The Pi Rust screen, and the Workflows workspace panel.
import type { PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { overviewRpc, runsListRpc } from "../shared/contracts";
import { isActive } from "../shared/runs";
import { ContextTab } from "./context";
import { ExtensionsTab } from "./extensions";
import { lastCwd, rememberCwd, type ManagerTab } from "./host";
import { OverviewTab } from "./overview";
import { PluginsTab } from "./plugins";
import { useRpcQuery } from "./queries";
import { RunView } from "./run-view";
import { RunsList } from "./runs";
import { SessionsTab } from "./sessions";
import { SkillsTab } from "./skills";
import { Badge, BrandMark, Row, Stack, TabBar, Txt, UiProvider, shortPath, useUi, type Navigation } from "./ui";
import { WorkflowsTab } from "./workflows";
import { kindIcon, useWorkspaceIndex, WorkspaceChip, WorkspacePickerModal } from "./workspaces";

const TABS: readonly { id: ManagerTab; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "LayoutDashboard" },
  { id: "extensions", label: "Extensions", icon: "Puzzle" },
  { id: "plugins", label: "Claude plugins", icon: "Store" },
  { id: "skills", label: "Skills", icon: "Sparkles" },
  { id: "context", label: "Context", icon: "ScrollText" },
  { id: "workflows", label: "Workflows", icon: "Workflow" },
  { id: "runs", label: "Runs", icon: "Activity" },
  { id: "sessions", label: "Sessions", icon: "History" },
];

function isTab(value: string | undefined): value is ManagerTab {
  return TABS.some((tab) => tab.id === value);
}

/** Counts of active runs and runs that wait for approval, for badges. */
export function useRunCounts(cwd?: string): { active: number; approvals: number } {
  const runs = useRpcQuery(runsListRpc, { cwd, limit: 100 }, { refetchInterval: 4000 });
  const live = (runs.data?.runs ?? []).filter((run) => isActive(run.status) && !run.stale);
  return { active: live.length, approvals: live.filter((run) => run.approval).length };
}

function runsBadge(counts: { active: number; approvals: number }) {
  return counts.approvals ? { badge: counts.approvals, badgeTone: "warning" as const } : counts.active ? { badge: counts.active, badgeTone: "accent" as const } : {};
}

export function ManagerScreen({ theme, layout, params, navigation }: PluginScreenProps) {
  return (
    <UiProvider theme={theme} compact={layout.compact} navigation={navigation as Navigation | undefined}>
      <Manager params={params} />
    </UiProvider>
  );
}

function WorkspaceSwitcher({ cwd, onPress }: { cwd: string; onPress: () => void }) {
  const { theme, compact } = useUi();
  const { workspace, project } = useWorkspaceIndex().find(cwd);
  const title = !cwd ? "No project" : workspace ? workspace.projectName : (project?.name ?? shortPath(cwd));
  const detail = !cwd ? "Global settings and workflows" : workspace ? workspace.label : cwd;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Workspace: ${title}, ${detail}. Change workspace`}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
        maxWidth: compact ? undefined : 380,
        alignSelf: compact ? "stretch" : "auto",
      })}
    >
      <Icon name={cwd ? kindIcon(workspace?.kind ?? null) : "Globe"} size={16} color={theme.colors.foregroundMuted} />
      <Stack gap={0} style={{ flexShrink: 1, flexGrow: compact ? 1 : 0 }}>
        <Row gap={6}>
          <Txt size="sm" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Txt>
          {workspace?.kind === "worktree" ? <Badge label="worktree" /> : workspace?.isMain ? <Badge label="main" /> : null}
        </Row>
        <Txt size="xs" tone="muted" numberOfLines={1} mono={!workspace && Boolean(cwd)}>
          {detail}
        </Txt>
      </Stack>
      <Icon name="ChevronsUpDown" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function Manager({ params }: { params: Record<string, string> }) {
  const { theme, compact } = useUi();
  const [tab, setTab] = useState<ManagerTab>(isTab(params.tab) ? params.tab : params.run ? "runs" : "overview");
  const [cwd, setCwdState] = useState(params.cwd ?? lastCwd());
  const [run, setRun] = useState<string | null>(params.run ?? null);
  const [picking, setPicking] = useState(false);
  const setCwd = (dir: string) => {
    setCwdState(dir);
    rememberCwd(dir);
  };
  const edit = params.edit ? { name: params.edit, scope: params.scope === "project" ? ("project" as const) : ("global" as const) } : null;
  useEffect(() => {
    if (isTab(params.tab)) setTab(params.tab);
    if (params.run) {
      setRun(params.run);
      setTab("runs");
    }
    if (params.cwd) setCwd(params.cwd);
    if (params.edit) setTab("workflows");
  }, [params.tab, params.run, params.cwd, params.edit]);
  const overview = useRpcQuery(overviewRpc, { cwd: cwd || undefined }, { staleTime: 30_000 });
  const counts = useRunCounts();
  const openRun = (id: string) => {
    setRun(id);
    setTab("runs");
  };
  const tabs = TABS.map((item) => (item.id === "runs" ? { ...item, ...runsBadge(counts) } : item));
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: compact ? 14 : 28, paddingTop: compact ? 14 : 24, paddingBottom: 48, gap: 20, maxWidth: 1180, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", justifyContent: "space-between", gap: 14 }}>
          <Row gap={12}>
            <BrandMark size={compact ? 26 : 30} />
            <Stack gap={0}>
              <Row gap={8}>
                <Txt size="xl" weight="700">
                  Pi Rust
                </Txt>
                {overview.data?.pi.version ? <Badge label={`v${overview.data.pi.version}`} /> : null}
              </Row>
              <Txt size="xs" tone="muted" numberOfLines={1}>
                {overview.data ? `pi · ${overview.data.agentDir}` : "Agent harness, extensions, and workflows"}
              </Txt>
            </Stack>
          </Row>
          <WorkspaceSwitcher cwd={cwd} onPress={() => setPicking(true)} />
        </View>
        <TabBar
          tabs={tabs}
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (next !== "runs") setRun(null);
          }}
        />
        <Stack gap={16}>
          {tab === "overview" ? <OverviewTab cwd={cwd} onNavigate={setTab} /> : null}
          {tab === "extensions" ? <ExtensionsTab cwd={cwd} onNavigate={setTab} /> : null}
          {tab === "plugins" ? <PluginsTab cwd={cwd} /> : null}
          {tab === "skills" ? <SkillsTab cwd={cwd} onOpenPlugins={() => setTab("plugins")} /> : null}
          {tab === "context" ? <ContextTab cwd={cwd} /> : null}
          {tab === "workflows" ? <WorkflowsTab cwd={cwd} onOpenRun={openRun} initialEdit={edit} /> : null}
          {tab === "runs" ? run ? <RunView id={run} onBack={() => setRun(null)} /> : <RunsList cwd={cwd || undefined} scopeToggle onOpen={setRun} /> : null}
          {tab === "sessions" ? <SessionsTab cwd={cwd} /> : null}
        </Stack>
      </ScrollView>
      <WorkspacePickerModal open={picking} value={cwd} allowNone title="Choose a workspace" onChange={setCwd} onClose={() => setPicking(false)} />
    </View>
  );
}

type PanelTab = "workflows" | "runs";

export function WorkflowsPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  return (
    <UiProvider theme={theme} compact={layout.compact} navigation={navigation as Navigation | undefined}>
      <Panel workspaceId={workspaceId} />
    </UiProvider>
  );
}

function Panel({ workspaceId }: { workspaceId: string }) {
  const { theme, compact } = useUi();
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [tab, setTab] = useState<PanelTab>("workflows");
  const [run, setRun] = useState<string | null>(null);
  const counts = useRunCounts(directory || undefined);
  const openRun = (id: string) => {
    setRun(id);
    setTab("runs");
  };
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: compact ? 12 : 18, paddingBottom: 40, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Row gap={10} justify="space-between" wrap>
          <Row gap={10} style={{ flexShrink: 1 }}>
            <BrandMark size={20} />
            {directory ? <WorkspaceChip dir={directory} open={false} size="md" /> : null}
          </Row>
        </Row>
        <TabBar
          tabs={[
            { id: "workflows" as const, label: "Workflows", icon: "Workflow" },
            { id: "runs" as const, label: "Runs", icon: "Activity", ...runsBadge(counts) },
          ]}
          value={tab}
          onChange={(next) => {
            setTab(next);
            setRun(null);
          }}
        />
        {!directory ? (
          <Txt tone="muted">This workspace has no directory.</Txt>
        ) : tab === "workflows" ? (
          <WorkflowsTab cwd={directory} onOpenRun={openRun} />
        ) : run ? (
          <RunView id={run} onBack={() => setRun(null)} />
        ) : (
          <RunsList cwd={directory} scopeToggle onOpen={setRun} />
        )}
      </ScrollView>
    </View>
  );
}
