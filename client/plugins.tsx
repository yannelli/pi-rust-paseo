// The Claude plugins tab: Claude Code plugin marketplaces and their plugins, through the
// claude-marketplace extension. Plugins bring skills, prompt commands, subagents, hooks, and MCP
// servers into pi. Every change runs `/claude-plugins …` in a temporary pi session.
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { claudeRunRpc, claudeStateRpc, type ClaudeAction, type ClaudePlugin, type ClaudeScope, type Marketplace, type PluginStatus } from "../shared/claude";
import { ExtensionGate, useExtension } from "./gate";
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
  Notice,
  Row,
  Section,
  Spinner,
  Stack,
  Switch,
  Txt,
  UiModal,
  useUi,
  type Tone,
} from "./ui";

const INVALIDATES = ["claude.state", "res.skills", "res.prompts", "res.read", "ext.commands"] as const;

type Filter = "installed" | "available" | "all";

const STATUS: Record<PluginStatus, { label: string; tone: Tone }> = {
  installed: { label: "on", tone: "success" },
  disabled: { label: "off", tone: "muted" },
  available: { label: "available", tone: "accent" },
  unavailable: { label: "unavailable", tone: "warning" },
};

interface Run {
  (action: ClaudeAction, target?: string, scope?: ClaudeScope): void;
}

export function PluginsTab({ cwd }: { cwd: string }) {
  const { theme, compact } = useUi();
  const { ext } = useExtension("claude-marketplace");
  const state = useRpcQuery(claudeStateRpc, { cwd: cwd || undefined }, { staleTime: 10_000 });
  const [last, setLast] = useState<{ command: string; ok: boolean; output: string } | null>(null);
  const run = useRpcMutation(claudeRunRpc, {
    invalidates: INVALIDATES,
    onSuccess: (result) => setLast(result),
    success: (result) => (result.ok ? "Done. Running pi sessions pick it up after /reload." : null),
  });
  const act: Run = (action, target, scope) => run.mutate({ cwd: cwd || undefined, action, target, scope });
  const busy = run.isPending ? `${run.variables?.action}:${run.variables?.target ?? ""}` : null;
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; action: ClaudeAction; target: string } | null>(null);
  const data = state.data;
  const canProject = Boolean(cwd) && data?.projectTrusted !== false;
  return (
    <Stack gap={24}>
      <ExtensionGate name="claude-marketplace">Claude plugins are installed and staged by this extension; until it is on, the lists below are read-only.</ExtensionGate>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", justifyContent: "space-between", gap: 12 }}>
        <Txt size="sm" tone="muted" style={{ flex: compact ? undefined : 1 }}>
          Add Claude Code plugin marketplaces and install their plugins into pi: their commands become prompt templates, and their skills, agents, hooks, and MCP servers load in pi sessions after /reload.
        </Txt>
        <Row gap={8} wrap>
          <IconButton icon="RefreshCw" label="Refresh" onPress={() => void state.refetch()} />
          <Button small variant="outline" icon="Import" label="Import from Claude Code" disabled={!ext?.enabled} busy={busy === "import:"} onPress={() => act("import", undefined, "user")} />
          <Button small variant="outline" icon="RefreshCcw" label="Update all" disabled={!ext?.enabled} busy={busy === "update-all:"} onPress={() => act("update-all")} />
          <Button small variant="primary" icon="Plus" label="Add marketplace" disabled={!ext?.enabled} onPress={() => setAdding(true)} />
        </Row>
      </View>
      {run.isPending ? <Notice tone="muted" title={`Running /claude-plugins ${describe(run.variables?.action, run.variables?.target)}`}>Cloning and pulling can take a minute.</Notice> : null}
      {last ? (
        <Card style={{ gap: 8 }}>
          <Row justify="space-between">
            <Row gap={8}>
              <Icon name={last.ok ? "CircleCheck" : "CircleX"} size={15} color={last.ok ? theme.colors.statusSuccess : theme.colors.statusDanger} />
              <Txt size="sm" weight="600" mono numberOfLines={1}>
                {last.command}
              </Txt>
            </Row>
            <IconButton icon="X" label="Dismiss" onPress={() => setLast(null)} />
          </Row>
          <CodeBlock text={last.output} maxHeight={220} />
        </Card>
      ) : null}
      {state.error ? <ErrorBox error={state.error} /> : null}
      {data?.warnings.map((warning) => (
        <Notice key={warning} tone="muted">
          {warning}
        </Notice>
      ))}
      {state.isLoading ? <Spinner label="Reading Claude plugins" /> : null}
      {data ? (
        <>
          <Marketplaces
            marketplaces={data.marketplaces}
            busy={busy}
            enabled={Boolean(ext?.enabled)}
            act={act}
            onRemove={(marketplace) =>
              setConfirm({
                title: `Remove ${marketplace.name}?`,
                body: `This uninstalls its ${marketplace.installed} installed plugin${marketplace.installed === 1 ? "" : "s"} and deletes the marketplace's clone.`,
                label: "Remove",
                action: "marketplace-remove",
                target: marketplace.name,
              })
            }
          />
          <Plugins
            plugins={data.plugins}
            busy={busy}
            enabled={Boolean(ext?.enabled)}
            canProject={canProject}
            act={act}
            onUninstall={(plugin) =>
              setConfirm({
                title: `Uninstall ${plugin.name}?`,
                body: "This removes its skills, commands, agents, hooks, and MCP servers from pi, and deletes its clone and data.",
                label: "Uninstall",
                action: "uninstall",
                target: plugin.id,
              })
            }
          />
        </>
      ) : null}
      <AddMarketplace open={adding} canProject={canProject} busy={run.isPending} onClose={() => setAdding(false)} onAdd={(source, scope) => {
        act("marketplace-add", source, scope);
        setAdding(false);
      }} />
      <ConfirmModal
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.label ?? "OK"}
        danger
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) act(confirm.action, confirm.target);
          setConfirm(null);
        }}
      />
    </Stack>
  );
}

function describe(action?: ClaudeAction, target?: string): string {
  if (!action) return "";
  const words = action.replace(/^marketplace-/, "marketplace ").replace("update-all", "update");
  return target ? `${words} ${target}` : words;
}

function Marketplaces({
  marketplaces,
  busy,
  enabled,
  act,
  onRemove,
}: {
  marketplaces: Marketplace[];
  busy: string | null;
  enabled: boolean;
  act: Run;
  onRemove: (marketplace: Marketplace) => void;
}) {
  const { compact } = useUi();
  return (
    <Section title={`Marketplaces · ${marketplaces.length}`} description="Git repositories or folders with a .claude-plugin/marketplace.json. Auto-update pulls one when a pi session starts.">
      {marketplaces.length === 0 ? (
        <Card>
          <Empty icon="Store" title="No marketplaces yet" body="Add one by GitHub owner/repo, git URL, or folder, such as anthropics/claude-plugins-official." />
        </Card>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {marketplaces.map((marketplace) => {
          const id = marketplace.name;
          return (
            <View key={`${marketplace.scope}:${id}`} style={{ width: compact ? "100%" : "48.8%", flexGrow: compact ? 0 : 1 }}>
              <Card style={{ gap: 8 }}>
                <Row gap={10} align="flex-start">
                  <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Row gap={6} wrap>
                      <Txt size="md" weight="600">
                        {marketplace.name}
                      </Txt>
                      {marketplace.scope === "project" ? <Badge label="workspace" tone="accent" /> : null}
                      <Badge label={`${marketplace.installed}/${marketplace.plugins} installed`} tone={marketplace.installed ? "success" : "muted"} />
                    </Row>
                    <Pressable accessibilityRole="link" disabled={!/^https?:/.test(marketplace.gitUrl ?? marketplace.source)} onPress={() => void openExternalUrl((marketplace.gitUrl ?? marketplace.source).replace(/\.git$/, ""))}>
                      <Txt size="xs" tone="muted" mono numberOfLines={1}>
                        {marketplace.source}
                      </Txt>
                    </Pressable>
                    {marketplace.description ? (
                      <Txt size="xs" tone="muted" numberOfLines={2}>
                        {marketplace.description}
                      </Txt>
                    ) : null}
                  </Stack>
                </Row>
                {marketplace.error ? <Notice tone="warning">{marketplace.error}</Notice> : null}
                <Row gap={8} justify="space-between" wrap>
                  <Row gap={8}>
                    <Switch
                      value={marketplace.autoUpdate}
                      disabled={!enabled || !marketplace.gitUrl}
                      busy={busy === `marketplace-autoupdate:${id}` || busy === `marketplace-noautoupdate:${id}`}
                      label={`Auto-update ${id}`}
                      onChange={(next) => act(next ? "marketplace-autoupdate" : "marketplace-noautoupdate", id)}
                    />
                    <Txt size="xs" tone="muted">
                      {marketplace.gitUrl ? "Auto-update" : "Local folder"}
                    </Txt>
                  </Row>
                  <Row gap={6}>
                    <Button small variant="ghost" icon="RefreshCcw" label="Update" disabled={!enabled} busy={busy === `marketplace-update:${id}`} onPress={() => act("marketplace-update", id)} />
                    <Button small variant="ghost" icon="Trash2" label="Remove" disabled={!enabled} onPress={() => onRemove(marketplace)} />
                  </Row>
                </Row>
              </Card>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function Plugins({
  plugins,
  busy,
  enabled,
  canProject,
  act,
  onUninstall,
}: {
  plugins: ClaudePlugin[];
  busy: string | null;
  enabled: boolean;
  canProject: boolean;
  act: Run;
  onUninstall: (plugin: ClaudePlugin) => void;
}) {
  const { theme } = useUi();
  const installedCount = plugins.filter((plugin) => plugin.status === "installed" || plugin.status === "disabled").length;
  const [filter, setFilter] = useState<Filter>(installedCount ? "installed" : "all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return plugins
      .filter((plugin) => (filter === "all" ? true : filter === "installed" ? plugin.status === "installed" || plugin.status === "disabled" : plugin.status === "available" || plugin.status === "unavailable"))
      .filter((plugin) => words.every((word) => `${plugin.id} ${plugin.description ?? ""} ${plugin.category ?? ""} ${plugin.keywords.join(" ")}`.toLowerCase().includes(word)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [plugins, filter, query]);
  return (
    <Section title={`Plugins · ${installedCount} installed of ${plugins.length}`} description="Turning a plugin off removes what it added and keeps it installed. Uninstall removes it.">
      <Row gap={10} wrap>
        <Chips
          options={[
            { label: `Installed · ${installedCount}`, value: "installed" as const },
            { label: `Available · ${plugins.length - installedCount}`, value: "available" as const },
            { label: "All", value: "all" as const },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field value={query} onChangeText={setQuery} placeholder="Search plugins" />
        </View>
      </Row>
      {shown.length === 0 ? (
        <Card>
          <Empty icon={query ? "SearchX" : "Package"} title={query ? "No plugins match" : filter === "installed" ? "No plugins installed" : "No plugins to show"} body={filter === "installed" && !query ? "Install one from Available." : undefined} />
        </Card>
      ) : (
        <Card padded={false} style={{ gap: 0 }}>
          {shown.map((plugin, index) => (
            <View key={plugin.id} style={{ borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
              <PluginRow
                plugin={plugin}
                busy={busy}
                enabled={enabled}
                canProject={canProject}
                expanded={open === plugin.id}
                onToggle={() => setOpen(open === plugin.id ? null : plugin.id)}
                act={act}
                onUninstall={() => onUninstall(plugin)}
              />
            </View>
          ))}
        </Card>
      )}
    </Section>
  );
}

function PluginRow({
  plugin,
  busy,
  enabled,
  canProject,
  expanded,
  onToggle,
  act,
  onUninstall,
}: {
  plugin: ClaudePlugin;
  busy: string | null;
  enabled: boolean;
  canProject: boolean;
  expanded: boolean;
  onToggle: () => void;
  act: Run;
  onUninstall: () => void;
}) {
  const { theme } = useUi();
  const installed = plugin.status === "installed" || plugin.status === "disabled";
  const status = STATUS[plugin.status];
  const isBusy = (action: ClaudeAction) => busy === `${action}:${plugin.id}`;
  const counts = plugin.resources
    ? [
        plugin.resources.skills.length ? `${plugin.resources.skills.length} skill${plugin.resources.skills.length === 1 ? "" : "s"}` : null,
        plugin.resources.commands.length ? `${plugin.resources.commands.length} command${plugin.resources.commands.length === 1 ? "" : "s"}` : null,
        plugin.resources.agents.length ? `${plugin.resources.agents.length} agent${plugin.resources.agents.length === 1 ? "" : "s"}` : null,
        plugin.resources.hooks ? "hooks" : null,
        plugin.resources.mcp.length ? `${plugin.resources.mcp.length} MCP` : null,
      ].filter(Boolean)
    : [];
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${plugin.name}. ${expanded ? "Close" : "Open"}`}
        onPress={onToggle}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ paddingHorizontal: 14, paddingVertical: 12, backgroundColor: hovered ? theme.colors.surface2 : "transparent" })}
      >
        <Row gap={12} align="flex-start">
          <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
            <Icon name="Package" size={15} color={plugin.status === "installed" ? theme.colors.foreground : theme.colors.foregroundMuted} />
          </View>
          <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
            <Row gap={6} wrap>
              <Txt size="sm" weight="600">
                {plugin.name}
              </Txt>
              <Txt size="xs" tone="muted">{`@${plugin.marketplace}`}</Txt>
              {plugin.version ? <Badge label={`v${plugin.version}`} /> : null}
              <Badge label={status.label} tone={status.tone} />
              {installed && plugin.scope === "project" ? <Badge label="workspace" tone="accent" /> : null}
              {plugin.category ? <Badge label={plugin.category} /> : null}
            </Row>
            {plugin.description ? (
              <Txt size="xs" tone="muted" numberOfLines={expanded ? undefined : 2}>
                {plugin.description}
              </Txt>
            ) : null}
            {counts.length ? (
              <Txt size="xs" tone="muted">
                {counts.join(" · ")}
              </Txt>
            ) : null}
          </Stack>
          {installed ? (
            <Switch
              value={plugin.status === "installed"}
              disabled={!enabled}
              busy={isBusy("enable") || isBusy("disable")}
              label={`${plugin.status === "installed" ? "Turn off" : "Turn on"} ${plugin.name}`}
              onChange={(next) => act(next ? "enable" : "disable", plugin.id)}
            />
          ) : plugin.status === "available" ? (
            <Button small variant="primary" icon="Download" label="Install" disabled={!enabled} busy={isBusy("install")} onPress={() => act("install", plugin.id, "user")} />
          ) : null}
        </Row>
      </Pressable>
      {expanded ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, paddingLeft: 56 }}>
          <Stack gap={10}>
            {plugin.reasons.map((reason) => (
              <Notice key={reason} tone={reason.startsWith("unsupported") ? "muted" : "warning"}>
                {reason.startsWith("unsupported:") ? `pi does not support this part of the plugin: ${reason.slice("unsupported:".length).trim()}` : reason}
              </Notice>
            ))}
            {plugin.resources ? <Resources resources={plugin.resources} /> : null}
            {!installed && plugin.remote ? (
              <Txt size="xs" tone="muted">
                Installing clones the plugin's own repository.
              </Txt>
            ) : null}
            <Row gap={6} wrap>
              {plugin.status === "available" && canProject ? (
                <Button small variant="outline" icon="FolderDown" label="Install in this workspace" disabled={!enabled} busy={isBusy("install")} onPress={() => act("install", plugin.id, "project")} />
              ) : null}
              {installed ? <Button small variant="outline" icon="RefreshCcw" label="Update" disabled={!enabled} busy={isBusy("update")} onPress={() => act("update", plugin.id)} /> : null}
              {installed ? <Button small variant="ghost" icon="RotateCcw" label="Reinstall" disabled={!enabled} busy={isBusy("reinstall")} onPress={() => act("reinstall", plugin.id)} /> : null}
              {plugin.homepage ? <Button small variant="ghost" icon="ExternalLink" label="Homepage" onPress={() => void openExternalUrl(plugin.homepage!)} /> : null}
              {installed ? <Button small variant="ghost" icon="Trash2" label="Uninstall" disabled={!enabled} busy={isBusy("uninstall")} onPress={onUninstall} /> : null}
            </Row>
          </Stack>
        </View>
      ) : null}
    </View>
  );
}

function Resources({ resources }: { resources: NonNullable<ClaudePlugin["resources"]> }) {
  const rows: { icon: string; label: string; items: string[] }[] = [
    { icon: "Sparkles", label: "Skills", items: resources.skills },
    { icon: "SquareSlash", label: "Commands", items: resources.commands.map((name) => `/${name}`) },
    { icon: "Bot", label: "Agents", items: resources.agents },
    { icon: "Server", label: "MCP servers", items: resources.mcp },
  ].filter((row) => row.items.length);
  if (!rows.length && !resources.hooks) return <Txt size="xs" tone="muted">It added nothing pi loads.</Txt>;
  return (
    <Stack gap={8}>
      {rows.map((row) => (
        <ResourceRow key={row.label} icon={row.icon} label={row.label} items={row.items} />
      ))}
      {resources.hooks ? <ResourceRow icon="Webhook" label="Hooks" items={["in the hooks extension's hooks.json"]} /> : null}
    </Stack>
  );
}

function ResourceRow({ icon, label, items }: { icon: string; label: string; items: string[] }) {
  const { theme } = useUi();
  return (
    <Row gap={8} align="flex-start">
      <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
      <Txt size="xs" weight="600" style={{ width: 86 }}>
        {label}
      </Txt>
      <Row gap={4} wrap style={{ flex: 1 }}>
        {items.map((item) => (
          <Badge key={item} label={item} />
        ))}
      </Row>
    </Row>
  );
}

function AddMarketplace({ open, canProject, busy, onClose, onAdd }: { open: boolean; canProject: boolean; busy: boolean; onClose: () => void; onAdd: (source: string, scope: ClaudeScope) => void }) {
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<ClaudeScope>("user");
  const error = /\s/.test(source.trim()) ? "The extension cannot take a source with spaces." : null;
  return (
    <UiModal title="Add a marketplace" open={open} onClose={onClose}>
      <Field
        label="Source"
        value={source}
        onChangeText={setSource}
        placeholder="anthropics/claude-plugins-official"
        mono
        error={error}
        hint="GitHub owner/repo, a git URL (https, ssh, git@), a local folder, or a path to marketplace.json. claude-plugins-official is Anthropic's."
      />
      {canProject ? (
        <Chips
          label="For"
          options={[
            { label: "Every workspace", value: "user" as const },
            { label: "This workspace", value: "project" as const },
          ]}
          value={scope}
          onChange={setScope}
        />
      ) : null}
      <Row gap={6} wrap>
        {["claude-plugins-official"].map((example) => (
          <Button key={example} small variant="ghost" label={example} onPress={() => setSource(example)} />
        ))}
      </Row>
      <Row justify="flex-end">
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button
          label="Add"
          variant="primary"
          icon="Plus"
          busy={busy}
          disabled={!source.trim() || Boolean(error)}
          onPress={() => {
            onAdd(source.trim(), canProject ? scope : "user");
            setSource("");
          }}
        />
      </Row>
    </UiModal>
  );
}
