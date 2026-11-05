// pi extensions: installed (global or per workspace), packages, the marketplace, and installs.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import {
  extensionsInfoRpc,
  extensionsListRpc,
  extensionsRunRpc,
  extensionsSearchRpc,
  type CommandResult,
  type ExtensionAction,
  type ExtensionInfo,
  type MarketplaceEntry,
  type PackageInfo,
  type ScopeName,
} from "../shared/contracts";
import { ExtensionDetail } from "./extension-detail";
import type { ManagerTab } from "./host";
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
  KeyValue,
  Notice,
  Row,
  Section,
  Spinner,
  Stack,
  Switch,
  Toggle,
  Txt,
  UiModal,
  useUi,
} from "./ui";
import { WorkspaceChip, WorkspaceNotices } from "./workspaces";

const INVALIDATES = ["ext.list", "ext.search", "pi.overview", "wf.catalog"] as const;

type Act = (action: ExtensionAction, target: string) => void;

/** Two columns on wide layouts, one on compact. */
function Grid({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>{children}</View>;
}

function Cell({ children }: { children: ReactNode }) {
  const { compact } = useUi();
  return <View style={{ flexBasis: compact ? "100%" : "48%", flexGrow: 1, minWidth: compact ? undefined : 300 }}>{children}</View>;
}

export function ExtensionsTab({ cwd, onNavigate }: { cwd: string; onNavigate?: (tab: ManagerTab) => void }) {
  const [scope, setScope] = useState<ScopeName>("global");
  const [last, setLast] = useState<{ label: string; result: CommandResult } | null>(null);
  const run = useRpcMutation(extensionsRunRpc, {
    invalidates: INVALIDATES,
    onSuccess: (result, input) => setLast({ label: `${input.action} ${input.target}`, result }),
    success: (result) => (result.ok ? "Done. New pi sessions load it; running ones need /reload." : null),
  });
  const act: Act = (action, target) => run.mutate({ action, target, scope, cwd: cwd || undefined });
  const busyTarget = run.isPending ? run.variables?.target : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRpcQuery(extensionsListRpc, { scope, cwd: cwd || undefined }, { staleTime: 10_000, enabled: Boolean(selected) });
  const selectedExt = selected ? list.data?.extensions.find((ext) => ext.reference === selected) : undefined;
  if (selected && selectedExt) {
    return (
      <ExtensionDetail
        ext={selectedExt}
        cwd={cwd}
        busy={busyTarget === selectedExt.reference}
        onToggle={() => act(selectedExt.enabled ? "disable" : "enable", selectedExt.reference)}
        onBack={() => setSelected(null)}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <Stack gap={24}>
      <Row gap={12} wrap justify="space-between">
        <Chips
          options={[
            { label: "Global", value: "global" as const },
            { label: "This workspace", value: "project" as const },
          ]}
          value={scope}
          onChange={setScope}
        />
        {scope === "project" && cwd ? <WorkspaceChip dir={cwd} /> : <Txt size="xs" tone="muted">~/.pi/agent/settings.json</Txt>}
      </Row>
      {scope === "project" ? (
        cwd ? (
          <WorkspaceNotices cwd={cwd} what="workspace extensions and packages" />
        ) : (
          <Notice tone="muted" title="No workspace chosen">
            Workspace extensions live in a project's .pi/settings.json. Choose a workspace at the top of the screen.
          </Notice>
        )
      ) : null}
      {scope === "project" && !cwd ? null : (
        <>
          {last ? (
            <Notice
              tone={last.result.ok ? "success" : "danger"}
              title={`pi ${last.label}: ${last.result.ok ? "done" : `failed${last.result.code !== null ? ` (exit ${last.result.code})` : ""}`}`}
              action={<Button small variant="ghost" label="Dismiss" onPress={() => setLast(null)} />}
            >
              {last.result.output ? <CodeBlock text={last.result.output} maxHeight={200} /> : null}
            </Notice>
          ) : null}
          <Installed scope={scope} cwd={cwd} act={act} busyTarget={busyTarget} onOpen={setSelected} />
          <Marketplace act={act} busyTarget={busyTarget} scope={scope} />
          <InstallSource scope={scope} act={act} busy={run.isPending && run.variables?.action === "install"} />
        </>
      )}
    </Stack>
  );
}

function Installed({ scope, cwd, act, busyTarget, onOpen }: { scope: ScopeName; cwd: string; act: Act; busyTarget?: string; onOpen: (reference: string) => void }) {
  const { theme } = useUi();
  const list = useRpcQuery(extensionsListRpc, { scope, cwd: cwd || undefined }, { staleTime: 10_000 });
  const [filter, setFilter] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const extensions = useMemo(() => {
    const words = filter.trim().toLowerCase();
    return (list.data?.extensions ?? []).filter((ext) => !words || `${ext.reference} ${ext.source}`.toLowerCase().includes(words));
  }, [list.data, filter]);
  const packages = (list.data?.packages ?? []).filter((pkg) => pkg.scope === scope);
  const enabled = (list.data?.extensions ?? []).filter((ext) => ext.enabled).length;
  return (
    <>
      <Section
        title="Installed"
        description={list.data ? `${enabled} of ${list.data.extensions.length} on. Changes apply to new pi sessions; running ones need /reload.` : undefined}
        right={<IconButton icon="RefreshCw" label="Refresh" onPress={() => void list.refetch()} />}
      >
        {list.error ? <ErrorBox error={list.error} /> : null}
        {list.isLoading ? <Spinner label="Reading pi's extensions" /> : null}
        {list.data ? (
          <Stack gap={10}>
            <Field value={filter} onChangeText={setFilter} placeholder={`Filter ${list.data.extensions.length} extensions`} />
            {extensions.length === 0 ? <Empty icon="SearchX" title="No extensions match" /> : null}
            <Grid>
              {extensions.map((ext) => (
                <Cell key={ext.reference}>
                  <ExtensionCard ext={ext} busy={busyTarget === ext.reference} onToggle={() => act(ext.enabled ? "disable" : "enable", ext.reference)} onOpen={() => onOpen(ext.reference)} />
                </Cell>
              ))}
            </Grid>
          </Stack>
        ) : null}
      </Section>
      <Section title="Packages" description={`What ${scope === "global" ? "~/.pi/agent" : "this workspace's"} settings.json installs. A package can hold several extensions, skills, and prompts.`}>
        {packages.length === 0 && list.data ? (
          <Txt size="sm" tone="muted">
            {`No ${scope === "global" ? "global" : "workspace"} packages yet.`}
          </Txt>
        ) : null}
        {packages.length > 0 ? (
          <Card padded={false} style={{ gap: 0 }}>
            {packages.map((pkg, index) => (
              <View key={`${pkg.scope}:${pkg.source}`} style={{ borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
                <PackageRow pkg={pkg} busy={busyTarget === pkg.source} onUpdate={() => act("update", pkg.source)} onRemove={() => setConfirmRemove(pkg.source)} />
              </View>
            ))}
          </Card>
        ) : null}
      </Section>
      <ConfirmModal
        open={confirmRemove !== null}
        title="Remove package"
        body={`Remove ${confirmRemove} from the ${scope === "global" ? "global" : "workspace"} settings and delete its installed files? Its extensions stop loading in new pi sessions.`}
        confirmLabel="Remove"
        danger
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) act("remove", confirmRemove);
          setConfirmRemove(null);
        }}
      />
    </>
  );
}

function ExtensionCard({ ext, busy, onToggle, onOpen }: { ext: ExtensionInfo; busy: boolean; onToggle: () => void; onOpen: () => void }) {
  const { theme } = useUi();
  const source = ext.source.replace(/^marketplace:/, "");
  return (
    <Card onPress={onOpen} accessibilityLabel={`Manage ${ext.name}`} style={{ gap: 6, paddingVertical: 12, opacity: ext.enabled ? 1 : 0.75 }}>
      <Row gap={10}>
        <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
          <Icon name={ext.name === "deferred" ? "Layers" : ext.builtin ? "Box" : "Puzzle"} size={15} color={ext.enabled ? theme.colors.foreground : theme.colors.foregroundMuted} />
        </View>
        <Stack gap={0} style={{ flex: 1 }}>
          <Row gap={6}>
            <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {ext.name}
            </Txt>
            {ext.builtin ? <Badge label="built-in" /> : null}
          </Row>
          <Txt size="xs" tone="muted" numberOfLines={1}>
            {ext.builtin ? "Ships with pi" : ext.source.startsWith("marketplace:") ? (source === ext.name ? "Marketplace" : `Marketplace · ${source}`) : ext.source}
          </Txt>
        </Stack>
        <Switch value={ext.enabled} busy={busy} label={`${ext.enabled ? "Disable" : "Enable"} ${ext.name}`} onChange={onToggle} />
        <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
      </Row>
    </Card>
  );
}

function PackageRow({ pkg, busy, onUpdate, onRemove }: { pkg: PackageInfo; busy: boolean; onUpdate: () => void; onRemove: () => void }) {
  return (
    <Row gap={10} style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
      <Stack gap={0} style={{ flex: 1 }}>
        <Row gap={6}>
          <Txt size="sm" weight="600" mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {pkg.source}
          </Txt>
          {pkg.filtered ? <Badge label="filtered" tone="warning" /> : null}
        </Row>
        {pkg.path ? (
          <Txt size="xs" tone="muted" mono numberOfLines={1}>
            {pkg.path}
          </Txt>
        ) : null}
      </Stack>
      <Button small variant="ghost" icon="RefreshCw" label="Update" busy={busy} onPress={onUpdate} />
      <IconButton icon="Trash2" label={`Remove ${pkg.source}`} tone="danger" disabled={busy} onPress={onRemove} />
    </Row>
  );
}

function InstallSource({ scope, act, busy }: { scope: ScopeName; act: Act; busy: boolean }) {
  const [source, setSource] = useState("");
  const valid = source.trim().length > 0;
  return (
    <Section title="Install from a source" description={`npm, Git, a URL, or a path. Installs into the ${scope === "global" ? "global" : "workspace"} settings with pi install${scope === "project" ? " -l" : ""}.`}>
      <Row gap={8} align="flex-start">
        <View style={{ flex: 1 }}>
          <Field
            value={source}
            onChangeText={setSource}
            placeholder="npm:@scope/pkg · git:github.com/user/repo · ./path"
            mono
            hint="Extensions run as code on the daemon machine. Install only sources you trust."
            onSubmit={() => valid && act("install", source.trim())}
          />
        </View>
        <Button label="Install" variant="primary" icon="Download" disabled={!valid} busy={busy} onPress={() => act("install", source.trim())} />
      </Row>
    </Section>
  );
}

function Marketplace({ act, busyTarget, scope }: { act: Act; busyTarget?: string; scope: ScopeName }) {
  const [query, setQuery] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const search = useRpcQuery(extensionsSearchRpc, { query: "" }, { staleTime: 300_000 });
  const words = query.trim().toLowerCase();
  const results = (search.data?.results ?? []).filter(
    (entry) => (!onlyAvailable || !entry.installed) && (!words || `${entry.name} ${entry.description}`.toLowerCase().includes(words)),
  );
  return (
    <Section
      title="Marketplace"
      description="Native Rust extensions from the pi-rust marketplace."
      right={<IconButton icon="RefreshCw" label="Refresh the marketplace" onPress={() => void search.refetch()} />}
    >
      <Row gap={12} wrap>
        <View style={{ flex: 1, minWidth: 220 }}>
          <Field value={query} onChangeText={setQuery} placeholder="Search by name or description" />
        </View>
        <Toggle label="Hide installed" value={onlyAvailable} onChange={setOnlyAvailable} />
      </Row>
      {search.isLoading ? <Spinner label="Reading the marketplace" /> : null}
      {search.data?.error ? <ErrorBox error={search.data.error} /> : null}
      {search.data && results.length === 0 && !search.data.error ? <Empty icon="Store" title="No marketplace extensions match" /> : null}
      <Grid>
        {results.map((entry) => (
          <Cell key={entry.name}>
            <MarketCard
              entry={entry}
              scope={scope}
              busy={busyTarget === `marketplace:${entry.name}`}
              onInstall={() => act(entry.installed ? "update" : "install", `marketplace:${entry.name}`)}
              onInfo={() => setInfo(entry.name)}
            />
          </Cell>
        ))}
      </Grid>
      <InfoModal name={info} onClose={() => setInfo(null)} />
    </Section>
  );
}

function MarketCard({ entry, busy, onInstall, onInfo, scope }: { entry: MarketplaceEntry; busy: boolean; onInstall: () => void; onInfo: () => void; scope: ScopeName }) {
  const upgradable = Boolean(entry.installed) && entry.installed?.replace(/^v/, "") !== entry.version;
  return (
    <Card style={{ flexGrow: 1, gap: 8 }}>
      <Row gap={8} justify="space-between">
        <Row gap={6} style={{ flexShrink: 1 }}>
          <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {entry.name}
          </Txt>
          <Txt size="xs" tone="muted">{`v${entry.version}`}</Txt>
        </Row>
        {upgradable ? <Badge label="update" tone="accent" icon="ArrowUp" /> : entry.installed ? <Badge label="installed" tone="success" icon="Check" /> : null}
      </Row>
      <Txt size="sm" tone="muted" numberOfLines={3} style={{ flex: 1 }}>
        {entry.description}
      </Txt>
      <Row gap={6} justify="flex-end">
        <Button small variant="ghost" label="Details" onPress={onInfo} />
        {entry.installed && !upgradable ? null : (
          <Button small variant={upgradable ? "secondary" : "primary"} icon={upgradable ? "ArrowUp" : "Download"} label={upgradable ? "Update" : scope === "project" ? "Install here" : "Install"} busy={busy} onPress={onInstall} />
        )}
      </Row>
    </Card>
  );
}

function InfoModal({ name, onClose }: { name: string | null; onClose: () => void }) {
  const info = useRpcQuery(extensionsInfoRpc, { name: name ?? "" }, { enabled: Boolean(name), staleTime: 300_000 });
  return (
    <UiModal title={info.data?.title ?? name ?? "Extension"} open={Boolean(name)} onClose={onClose}>
      {info.isLoading ? <Spinner /> : null}
      {info.error ? <ErrorBox error={info.error} /> : null}
      {info.data ? (
        <Stack gap={10}>
          {info.data.description ? <Txt size="sm">{info.data.description}</Txt> : null}
          {Object.entries(info.data.fields).map(([key, value]) => (
            <KeyValue key={key} label={key} value={value} mono={key === "Install"} />
          ))}
        </Stack>
      ) : null}
    </UiModal>
  );
}
