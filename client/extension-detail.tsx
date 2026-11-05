// One extension: its switch, description, docs, commands you can run from Paseo, config files,
// and, for `deferred`, its rule manager.
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import {
  extensionCommandRunRpc,
  extensionCommandsRpc,
  extensionConfigReadRpc,
  extensionConfigWriteRpc,
  extensionDocsUrl,
  extensionsInfoRpc,
  type ExtensionCommand,
  type ExtensionInfo,
} from "../shared/contracts";
import { DeferredManager } from "./deferred";
import type { ManagerTab } from "./host";

/** Extensions with a tab of their own. */
const MANAGED_BY_TAB: Record<string, { tab: ManagerTab; label: string; icon: string; title: string; body: string }> = {
  "claude-marketplace": {
    tab: "plugins",
    label: "Claude plugins",
    icon: "Store",
    title: "Manage marketplaces and plugins",
    body: "The Claude plugins tab adds marketplaces, installs plugins, and turns them on and off.",
  },
  "context-include": {
    tab: "context",
    label: "Context",
    icon: "ScrollText",
    title: "See what it includes",
    body: "The Context tab lists the @path lines of each context file and whether their files exist.",
  },
};
import { useRpcMutation, useRpcQuery } from "./queries";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
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
  shortPath,
  tint,
  useUi,
} from "./ui";

export function ExtensionDetail({
  ext,
  cwd,
  busy,
  onToggle,
  onBack,
  onNavigate,
}: {
  ext: ExtensionInfo;
  cwd: string;
  busy: boolean;
  onToggle: () => void;
  onBack: () => void;
  onNavigate?: (tab: ManagerTab) => void;
}) {
  const manager = MANAGED_BY_TAB[ext.name];
  const { theme, compact } = useUi();
  const marketplace = ext.source.startsWith("marketplace:") ? ext.source.slice("marketplace:".length) : null;
  const info = useRpcQuery(extensionsInfoRpc, { name: marketplace ?? ext.name }, { enabled: Boolean(marketplace), staleTime: 300_000 });
  return (
    <Stack gap={24}>
      <Stack gap={12}>
        <Row gap={10} wrap>
          <IconButton icon="ArrowLeft" label="Back to extensions" onPress={onBack} />
          <View style={{ width: 36, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: tint(theme.colors.accent, 0.22) }}>
            <Icon name={ext.name === "deferred" ? "Layers" : ext.builtin ? "Box" : "Puzzle"} size={18} color={theme.colors.foreground} />
          </View>
          <Stack gap={0} style={{ flex: 1, minWidth: 160 }}>
            <Row gap={8} wrap>
              <Txt size="xl" weight="700">
                {ext.name}
              </Txt>
              {ext.builtin ? <Badge label="built-in" /> : null}
              {info.data?.fields.Installed ? <Badge label={info.data.fields.Installed} /> : null}
            </Row>
            <Txt size="xs" tone="muted" mono numberOfLines={1}>
              {ext.reference}
            </Txt>
          </Stack>
          <Row gap={10}>
            {marketplace ? <Button small variant="outline" icon="BookOpen" label="Docs" onPress={() => void openExternalUrl(extensionDocsUrl(marketplace))} /> : null}
            <Txt size="sm" tone="muted">
              {ext.enabled ? "On" : "Off"}
            </Txt>
            <Switch value={ext.enabled} busy={busy} label={`${ext.enabled ? "Disable" : "Enable"} ${ext.name}`} onChange={onToggle} />
          </Row>
        </Row>
        {info.data?.description ? (
          <Txt size="sm" tone="muted" style={{ maxWidth: compact ? undefined : 760 }}>
            {info.data.description}
          </Txt>
        ) : null}
        {!ext.enabled ? <Notice tone="muted">This extension is off, so pi does not load it and its commands do not run.</Notice> : null}
      </Stack>
      {ext.name === "deferred" ? <DeferredManager cwd={cwd} /> : null}
      {manager && onNavigate ? (
        <Notice tone="muted" title={manager.title} action={<Button small variant="primary" icon={manager.icon} label={`Open ${manager.label}`} onPress={() => onNavigate(manager.tab)} />}>
          {manager.body}
        </Notice>
      ) : null}
      <Commands ext={ext} cwd={cwd} />
      <ConfigFiles name={marketplace ?? ext.name} cwd={cwd} />
    </Stack>
  );
}

function Commands({ ext, cwd }: { ext: ExtensionInfo; cwd: string }) {
  const list = useRpcQuery(extensionCommandsRpc, { cwd: cwd || undefined }, { staleTime: 60_000, enabled: ext.enabled });
  const commands = (list.data?.commands ?? []).filter((command) => command.extension === ext.reference);
  const [open, setOpen] = useState<string | null>(null);
  if (!ext.enabled) return null;
  return (
    <Section
      title="Commands"
      description="Run the extension's slash commands here. Each runs in a temporary pi session in this workspace; one that starts an agent turn is stopped, so use it in a pi agent instead."
      right={<IconButton icon="RefreshCw" label="Refresh the commands" onPress={() => void list.refetch()} />}
    >
      {list.isLoading ? <Spinner label="Asking pi for its commands" /> : null}
      {list.data?.error ? <ErrorBox error={list.data.error} /> : null}
      {list.data && commands.length === 0 && !list.data.error ? (
        <Card>
          <Empty icon="SquareSlash" title="No commands" body="This extension adds tools or behavior, not slash commands." />
        </Card>
      ) : null}
      {commands.length ? (
        <Card padded={false} style={{ gap: 0 }}>
          {commands.map((command, index) => (
            <CommandRow key={command.name} command={command} cwd={cwd} first={index === 0} expanded={open === command.name} onToggle={() => setOpen(open === command.name ? null : command.name)} />
          ))}
        </Card>
      ) : null}
    </Section>
  );
}

function CommandRow({ command, cwd, first, expanded, onToggle }: { command: ExtensionCommand; cwd: string; first: boolean; expanded: boolean; onToggle: () => void }) {
  const { theme } = useUi();
  const [args, setArgs] = useState("");
  const run = useRpcMutation(extensionCommandRunRpc, { toastErrors: false });
  const result = run.data;
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`/${command.name}`}
        onPress={onToggle}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: hovered ? theme.colors.surface2 : "transparent" })}
      >
        <Txt size="sm" mono weight="600">
          {`/${command.name}`}
        </Txt>
        <Txt size="xs" tone="muted" numberOfLines={expanded ? undefined : 1} style={{ flex: 1 }}>
          {command.description}
        </Txt>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
      {expanded ? (
        <Stack gap={10} style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <Row gap={8} align="flex-start">
            <View style={{ flex: 1 }}>
              <Field value={args} onChangeText={setArgs} placeholder="arguments" mono onSubmit={() => run.mutate({ cwd: cwd || undefined, command: command.name, args })} />
            </View>
            <Button label="Run" variant="primary" icon="Play" busy={run.isPending} onPress={() => run.mutate({ cwd: cwd || undefined, command: command.name, args })} />
          </Row>
          {run.error ? <ErrorBox error={run.error} /> : null}
          {result ? (
            <Stack gap={8}>
              {result.output.length ? (
                result.output.map((notice, index) => (
                  <Stack key={index} gap={4}>
                    {notice.level !== "info" ? <Badge label={notice.level} tone={notice.level === "error" ? "danger" : notice.level === "warning" ? "warning" : "muted"} /> : null}
                    <CodeBlock text={notice.text} maxHeight={360} />
                  </Stack>
                ))
              ) : (
                <Txt size="sm" tone="muted">
                  {`/${command.name} ran and printed nothing.`}
                </Txt>
              )}
              {result.neededUi ? <Notice tone="muted">The command asked a question that needs pi's UI; it was cancelled. Run it in a pi agent to answer.</Notice> : null}
              {result.agentInvoked ? <Notice tone="warning">The command started an agent turn, which was stopped. Run it in a pi agent instead.</Notice> : null}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </View>
  );
}

export function ConfigFiles({ name, cwd }: { name: string; cwd: string }) {
  const read = useRpcQuery(extensionConfigReadRpc, { name, cwd: cwd || undefined }, { staleTime: 10_000 });
  const files = read.data?.files ?? [];
  return (
    <Section title="Config files" description={`ext/${name}.json in pi's agent directory, and in this workspace's .pi folder. Not every extension reads one; see its docs.`}>
      {read.isLoading ? <Spinner /> : null}
      {read.error ? <ErrorBox error={read.error} /> : null}
      {files.map((file) => (
        <ConfigFile key={file.path} name={name} cwd={cwd} file={file} />
      ))}
    </Section>
  );
}

function ConfigFile({ name, cwd, file }: { name: string; cwd: string; file: { scope: "global" | "project"; path: string; exists: boolean; text: string } }) {
  const [open, setOpen] = useState(file.exists);
  const [text, setText] = useState(file.text);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(file.text), [file.text]);
  const write = useRpcMutation(extensionConfigWriteRpc, { invalidates: ["ext.config.read"], success: (result) => `Saved ${shortPath(result.path)}` });
  const validate = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      setError(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "The config must be a JSON object.");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Row justify="space-between" gap={8}>
        <Stack gap={0} style={{ flex: 1 }}>
          <Row gap={6}>
            <Txt size="sm" weight="600">
              {file.scope === "global" ? "Global" : "This workspace"}
            </Txt>
            <Badge label={file.exists ? "exists" : "no file"} tone={file.exists ? "success" : "muted"} />
          </Row>
          <Txt size="xs" tone="muted" mono numberOfLines={1}>
            {file.path}
          </Txt>
        </Stack>
        <Button small variant="outline" label={open ? "Close" : file.exists ? "Edit" : "Create"} onPress={() => setOpen(!open)} />
      </Row>
      {open ? (
        <Stack gap={8}>
          <Field
            value={text}
            onChangeText={(value) => {
              setText(value);
              validate(value);
            }}
            multiline
            mono
            minHeight={160}
            error={error}
          />
          {write.error ? <ErrorBox error={write.error} /> : null}
          <Row justify="flex-end">
            <Button label="Revert" variant="ghost" disabled={text === file.text} onPress={() => setText(file.text)} />
            <Button label="Save" variant="primary" disabled={Boolean(error) || (file.exists && text === file.text)} busy={write.isPending} onPress={() => write.mutate({ name, scope: file.scope, cwd: cwd || undefined, text })} />
          </Row>
        </Stack>
      ) : null}
    </Card>
  );
}
