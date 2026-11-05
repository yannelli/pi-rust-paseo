// Paseo workspaces as pi sees them: projects with their main checkout and worktrees, the
// workspace a directory belongs to, and pickers and chips that name it by project and branch.
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { dirInfoRpc } from "../shared/contracts";
import { useRpcQuery } from "./queries";
import { Badge, Button, Field, Notice, Row, Stack, Txt, shortPath, tint, useUi } from "./ui";

export type WorkspaceKind = "worktree" | "checkout" | "directory";

export interface WorkspaceInfo {
  id: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  directory: string;
  /** The workspace title, else its branch, else its name. */
  label: string;
  branch: string | null;
  kind: WorkspaceKind;
  /** The project's own checkout, not a worktree of it. */
  isMain: boolean;
  dirty: boolean;
  pr: { number: number | null; title: string; url: string; state: string } | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  workspaces: WorkspaceInfo[];
}

export interface WorkspaceIndex {
  projects: ProjectInfo[];
  workspaces: WorkspaceInfo[];
  loading: boolean;
  /** The workspace whose directory holds `dir`, preferring the deepest match. */
  find(dir: string | null | undefined): { workspace: WorkspaceInfo | null; project: ProjectInfo | null };
}

interface RawWorkspace {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectRootPath: string;
  workspaceDirectory?: string;
  workspaceKind?: string;
  name: string;
  title?: string | null;
  internal?: boolean;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null; isPaseoOwnedWorktree?: boolean; isDirty?: boolean | null } | null;
  githubRuntime?: { pullRequest?: { number?: number; title: string; url: string; state: string } | null } | null;
}

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir;
}

function within(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(`${parent}/`) || dir.startsWith(`${parent}\\`);
}

export function toWorkspace(raw: RawWorkspace): WorkspaceInfo {
  const directory = trimSlash(raw.workspaceDirectory ?? raw.projectRootPath);
  const root = trimSlash(raw.projectRootPath);
  const kind: WorkspaceKind = raw.workspaceKind === "worktree" ? "worktree" : raw.workspaceKind === "directory" ? "directory" : "checkout";
  const branch = raw.gitRuntime?.currentBranch ?? null;
  const pr = raw.githubRuntime?.pullRequest;
  return {
    id: raw.id,
    projectId: raw.projectId,
    projectName: raw.projectCustomName || raw.projectDisplayName,
    projectRoot: root,
    directory,
    label: raw.title || branch || raw.name,
    branch,
    kind,
    isMain: kind !== "worktree" && directory === root,
    dirty: Boolean(raw.gitRuntime?.isDirty),
    pr: pr ? { number: pr.number ?? null, title: pr.title, url: pr.url, state: pr.state } : null,
  };
}

export function buildIndex(raw: RawWorkspace[]): Omit<WorkspaceIndex, "loading"> {
  const workspaces = raw.filter((entry) => !entry.internal && !entry.archivingAt).map(toWorkspace);
  const byProject = new Map<string, ProjectInfo>();
  for (const workspace of workspaces) {
    const project = byProject.get(workspace.projectId) ?? { id: workspace.projectId, name: workspace.projectName, root: workspace.projectRoot, workspaces: [] };
    project.workspaces.push(workspace);
    byProject.set(workspace.projectId, project);
  }
  const projects = [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const project of projects) {
    project.workspaces.sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.label.localeCompare(b.label));
  }
  const find = (dir: string | null | undefined) => {
    if (!dir) return { workspace: null, project: null };
    const target = trimSlash(dir);
    let best: WorkspaceInfo | null = null;
    for (const workspace of workspaces) {
      if (within(target, workspace.directory) && (!best || workspace.directory.length > best.directory.length)) best = workspace;
    }
    const project = best ? (byProject.get(best.projectId) ?? null) : (projects.find((p) => within(target, p.root)) ?? null);
    return { workspace: best, project };
  };
  return { projects, workspaces, find };
}

export function useWorkspaceIndex(): WorkspaceIndex {
  const paseo = usePaseo();
  const query = useQuery({
    queryKey: ["paseo.workspaces"],
    queryFn: async () => (await paseo.workspaces.list()).entries as unknown as RawWorkspace[],
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  return useMemo(() => ({ ...buildIndex(query.data ?? []), loading: query.isLoading }), [query.data, query.isLoading]);
}

export function kindIcon(kind: WorkspaceKind | null): string {
  return kind === "worktree" ? "GitBranch" : kind === "checkout" ? "FolderGit2" : "Folder";
}

/** Facts pi cares about for a directory: git checkout, worktree, and trust. */
export function useDirInfo(cwd: string | null | undefined) {
  return useRpcQuery(dirInfoRpc, { cwd: cwd || "/" }, { enabled: Boolean(cwd), staleTime: 10_000 });
}

/** `Project · branch` for a directory, with its kind, and an Open action when it is a Paseo workspace. */
export function WorkspaceChip({ dir, open = true, size = "sm" }: { dir: string; open?: boolean; size?: "sm" | "md" }) {
  const { theme, navigation } = useUi();
  const index = useWorkspaceIndex();
  const { workspace, project } = index.find(dir);
  const label = workspace ? `${workspace.projectName} · ${workspace.label}` : project ? `${project.name} · ${shortPath(dir)}` : shortPath(dir);
  const kind = workspace?.kind ?? null;
  const canOpen = open && workspace && navigation;
  return (
    <Row gap={6} style={{ flexShrink: 1 }}>
      <Icon name={kindIcon(kind)} size={size === "md" ? 15 : 13} color={theme.colors.foregroundMuted} />
      <Txt size={size === "md" ? "md" : "sm"} tone={workspace ? "default" : "muted"} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Txt>
      {workspace?.kind === "worktree" ? <Badge label="worktree" /> : null}
      {workspace?.dirty ? <View accessibilityLabel="uncommitted changes" style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusWarning }} /> : null}
      {canOpen ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open workspace ${label}`} hitSlop={6} onPress={() => navigation?.openWorkspace({ workspaceId: workspace.id })}>
          <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </Row>
  );
}

function PickerRow({
  icon,
  title,
  detail,
  badges,
  selected,
  indent,
  onPress,
}: {
  icon: string;
  title: string;
  detail?: string;
  badges?: ReactNode;
  selected: boolean;
  indent?: boolean;
  onPress: () => void;
}) {
  const { theme } = useUi();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 10,
        marginLeft: indent ? 14 : 0,
        borderRadius: 8,
        backgroundColor: selected ? tint(theme.colors.accent, 0.22) : hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={15} color={selected ? theme.colors.foreground : theme.colors.foregroundMuted} />
      <Stack gap={0} style={{ flex: 1 }}>
        <Row gap={6}>
          <Txt size="sm" weight={selected ? "600" : "500"} numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </Txt>
          {badges}
        </Row>
        {detail ? (
          <Txt size="xs" tone="muted" mono numberOfLines={1}>
            {detail}
          </Txt>
        ) : null}
      </Stack>
      {selected ? <Icon name="Check" size={15} color={theme.colors.foreground} /> : null}
    </Pressable>
  );
}

/** Workspaces grouped by project, a search, and a typed path. `value` empty means no project. */
export function WorkspacePicker({
  value,
  onChange,
  allowNone,
  maxHeight = 380,
}: {
  value: string;
  onChange: (dir: string) => void;
  allowNone?: boolean;
  maxHeight?: number;
}) {
  const { theme } = useUi();
  const index = useWorkspaceIndex();
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const words = query.trim().toLowerCase();
  const projects = index.projects
    .map((project) => ({
      ...project,
      workspaces: project.workspaces.filter((w) => !words || `${project.name} ${w.label} ${w.branch ?? ""} ${w.directory}`.toLowerCase().includes(words)),
    }))
    .filter((project) => project.workspaces.length > 0);
  const known = index.find(value).workspace?.directory === value;
  return (
    <Stack gap={10}>
      <Field value={query} onChangeText={setQuery} placeholder={`Search ${index.workspaces.length} workspaces by project, branch, or path`} />
      <View style={{ maxHeight, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
        <ScrollView contentContainerStyle={{ padding: 6, gap: 2 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {allowNone && !words ? <PickerRow icon="Globe" title="No project" detail="Global settings, extensions, and workflows only" selected={!value} onPress={() => onChange("")} /> : null}
          {index.loading ? (
            <Txt size="sm" tone="muted" style={{ padding: 10 }}>
              Loading workspaces…
            </Txt>
          ) : null}
          {projects.map((project) => (
            <Stack key={project.id} gap={2} style={{ marginTop: 6 }}>
              <Row gap={8} style={{ paddingHorizontal: 10, paddingVertical: 4 }}>
                <Txt size="xs" weight="600" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {project.name.toUpperCase()}
                </Txt>
                <Txt size="xs" tone="muted" mono numberOfLines={1} style={{ flexShrink: 1 }}>
                  {shortPath(project.root)}
                </Txt>
              </Row>
              {project.workspaces.map((workspace) => (
                <PickerRow
                  key={workspace.id}
                  icon={kindIcon(workspace.kind)}
                  title={workspace.label}
                  detail={workspace.isMain ? workspace.directory : shortPath(workspace.directory)}
                  selected={workspace.directory === value}
                  onPress={() => onChange(workspace.directory)}
                  badges={
                    <>
                      {workspace.isMain ? <Badge label="main checkout" /> : workspace.kind === "worktree" ? <Badge label="worktree" /> : null}
                      {workspace.pr?.number ? <Badge label={`#${workspace.pr.number}`} icon="GitPullRequest" /> : null}
                      {workspace.dirty ? <Badge label="changes" tone="warning" /> : null}
                    </>
                  }
                />
              ))}
            </Stack>
          ))}
          {!index.loading && projects.length === 0 ? (
            <Txt size="sm" tone="muted" style={{ padding: 10 }}>
              No workspace matches.
            </Txt>
          ) : null}
        </ScrollView>
      </View>
      <Row gap={8} align="flex-end">
        <View style={{ flex: 1 }}>
          <Field label="Another directory" value={typed} onChangeText={setTyped} placeholder="/absolute/path" mono onSubmit={() => typed.trim() && onChange(typed.trim())} />
        </View>
        <Button label="Use" disabled={!typed.trim()} onPress={() => onChange(typed.trim())} />
      </Row>
      {value && !known ? (
        <Txt size="xs" tone="muted" mono>
          {`Using ${value}`}
        </Txt>
      ) : null}
    </Stack>
  );
}

export function WorkspacePickerModal({
  open,
  title = "Choose a workspace",
  value,
  allowNone,
  onChange,
  onClose,
}: {
  open: boolean;
  title?: string;
  value: string;
  allowNone?: boolean;
  onChange: (dir: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <WorkspacePicker
          value={value}
          allowNone={allowNone}
          maxHeight={460}
          onChange={(dir) => {
            onChange(dir);
            onClose();
          }}
        />
      </Modal.Content>
    </Modal>
  );
}

/** What pi does with a worktree's or an untrusted directory's `.pi/` files. */
export function WorkspaceNotices({ cwd, what = "project workflows, settings, and extensions" }: { cwd: string; what?: string }) {
  const info = useDirInfo(cwd);
  const index = useWorkspaceIndex();
  if (!cwd || !info.data) return null;
  const data = info.data;
  const main = data.git?.mainCheckout ? index.find(data.git.mainCheckout).workspace : null;
  return (
    <Stack gap={8}>
      {!data.exists ? <Notice tone="danger">{`${cwd} does not exist on the daemon machine.`}</Notice> : null}
      {data.exists && !data.trusted ? (
        <Notice tone="warning" title="pi does not trust this directory">
          {`pi ignores its .pi folder, so ${what} here do not load. Start pi in this directory once and trust it, or set defaultProjectTrust to "always".`}
        </Notice>
      ) : null}
      {data.git?.isWorktree ? (
        <Notice tone="muted" title={`Worktree of ${main?.projectName ?? shortPath(data.git.mainCheckout)}${data.git.branch ? ` on ${data.git.branch}` : ""}`}>
          {`Its .pi folder belongs to this worktree: ${what} saved here go away when the worktree does, unless you commit them. The main checkout is ${data.git.mainCheckout}.`}
        </Notice>
      ) : null}
    </Stack>
  );
}

export interface NewWorktree {
  projectId: string;
  projectRoot: string;
  branchName?: string;
  baseBranch?: string;
  title?: string;
}

/** Creates a Paseo worktree workspace and returns its id and directory. */
export async function createWorktree(paseo: ReturnType<typeof usePaseo>, request: NewWorktree): Promise<{ id: string; directory: string }> {
  const handle = await paseo.workspaces.create({
    title: request.title,
    source: {
      kind: "worktree",
      cwd: request.projectRoot,
      projectId: request.projectId,
      action: "branch-off",
      branchName: request.branchName || undefined,
      baseBranch: request.baseBranch || undefined,
    },
  });
  let directory = handle.directory;
  if (!directory) directory = (await handle.refresh())?.workspaceDirectory ?? null;
  if (!directory) throw new Error("Paseo created the worktree but did not report its directory.");
  return { id: handle.id, directory };
}
