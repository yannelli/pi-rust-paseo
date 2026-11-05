// The Skills tab: skills and prompt templates from every place pi reads them, in the order pi ranks
// them. Turn one off (a `skills` or `prompts` settings entry, as `pi config` writes), edit it,
// create one, or delete it. Skills and prompts of Claude plugins are managed in their plugin.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { deferredConfigRpc, decide, type DeferredMode } from "../shared/deferred";
import {
  NEW_SKILL_LOCATIONS,
  SKILL_LOCATION_LABELS,
  promptCreateRpc,
  promptNameError,
  promptsRpc,
  resourceReadRpc,
  resourceToggleRpc,
  skillCreateRpc,
  skillDeleteRpc,
  skillNameError,
  skillsRpc,
  type NewSkillLocation,
  type Prompt,
  type Skill,
} from "../shared/resources";
import { FILE_QUERIES, FileCard } from "./files";
import { useExtension } from "./gate";
import { useRpcMutation, useRpcQuery } from "./queries";
import { Badge, Button, Card, Chips, ConfirmModal, Empty, ErrorBox, Field, IconButton, Notice, Row, Section, Spinner, Stack, Switch, Txt, UiModal, shortPath, useUi } from "./ui";

type ListKind = "skills" | "prompts";
type Item = (Skill | Prompt) & { kind: ListKind };

const GROUP_ORDER = ["other", "project", "project-agents", "agent", "agents-home", "claude-plugin"] as const;
const PROMPT_LABELS: Record<Prompt["location"], string> = {
  project: "Workspace .pi/prompts",
  agent: "pi prompts",
  "claude-plugin": "Claude plugins",
  other: "Packages and settings",
};
/** Rows shown per group before "Show all". */
const PAGE = 40;

export function SkillsTab({ cwd, onOpenPlugins }: { cwd: string; onOpenPlugins?: () => void }) {
  const [view, setView] = useState<ListKind>("skills");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const skills = useRpcQuery(skillsRpc, { cwd: cwd || undefined }, { staleTime: 15_000, enabled: view === "skills" });
  const prompts = useRpcQuery(promptsRpc, { cwd: cwd || undefined }, { staleTime: 15_000, enabled: view === "prompts" });
  const active = view === "skills" ? skills : prompts;
  const items: Item[] = useMemo(() => {
    const list: Item[] = view === "skills" ? (skills.data?.skills ?? []).map((skill) => ({ ...skill, kind: "skills" as const })) : (prompts.data?.prompts ?? []).map((prompt) => ({ ...prompt, kind: "prompts" as const }));
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((item) => words.every((word) => `${item.name} ${item.description} ${item.plugin ?? ""}`.toLowerCase().includes(word)));
  }, [view, skills.data, prompts.data, query]);
  const total = view === "skills" ? (skills.data?.skills.length ?? 0) : (prompts.data?.prompts.length ?? 0);
  const on = (view === "skills" ? (skills.data?.skills ?? []) : (prompts.data?.prompts ?? [])).filter((item) => item.enabled && !item.shadowedBy).length;
  const trusted = view === "skills" ? skills.data?.trusted : prompts.data?.trusted;
  const deferred = useDeferredModes(cwd, view === "skills");
  return (
    <Stack gap={20}>
      <Row gap={10} justify="space-between" wrap>
        <Chips
          options={[
            { label: "Skills", value: "skills" as const },
            { label: "Prompt templates", value: "prompts" as const },
          ]}
          value={view}
          onChange={(next) => {
            setView(next);
            setQuery("");
          }}
        />
        <Row gap={8}>
          <IconButton icon="RefreshCw" label="Refresh" onPress={() => void (view === "skills" ? skills.refetch() : prompts.refetch())} />
          <Button icon="Plus" variant="primary" label={view === "skills" ? "New skill" : "New prompt"} onPress={() => setCreating(true)} />
        </Row>
      </Row>
      <Txt size="sm" tone="muted">
        {view === "skills"
          ? "Skills are instructions the model loads when a task needs them; /skill:name runs one. pi reads them from these folders, first one of a name wins."
          : "Prompt templates are Markdown files that /name expands into a message. $1, $@, and $ARGUMENTS stand for what you type after the name."}
      </Txt>
      {cwd && trusted === false ? <Notice title="pi does not trust this workspace">{`It ignores the workspace's own ${view === "skills" ? "skills" : "prompts"} and settings until you trust it.`}</Notice> : null}
      {view === "skills" && skills.data && !skills.data.skillCommands ? <Notice tone="muted">/skill:name commands are off (enableSkillCommands is false); the model still sees the skills.</Notice> : null}
      {active.error ? <ErrorBox error={active.error} /> : null}
      {(view === "skills" ? skills.data?.warnings : prompts.data?.warnings)?.map((warning) => (
        <Notice key={warning} tone="muted">
          {warning}
        </Notice>
      ))}
      {active.isLoading ? <Spinner label={view === "skills" ? "Finding skills" : "Finding prompt templates"} /> : null}
      {active.data ? (
        <>
          <Field value={query} onChangeText={setQuery} placeholder={`Search ${total} ${view === "skills" ? "skills" : "prompt templates"} · ${on} in use`} />
          {items.length === 0 ? (
            <Card>
              <Empty
                icon={query ? "SearchX" : view === "skills" ? "Sparkles" : "SquareSlash"}
                title={query ? "Nothing matches" : view === "skills" ? "No skills yet" : "No prompt templates yet"}
                body={query ? undefined : "Create one here, or install a Claude plugin that has some."}
              />
            </Card>
          ) : null}
          {GROUP_ORDER.map((location) => {
            const group = items.filter((item) => item.location === location);
            if (!group.length) return null;
            const title = view === "skills" ? SKILL_LOCATION_LABELS[location] : PROMPT_LABELS[location as Prompt["location"]];
            const root = active.data!.roots.find((entry) => entry.location === location);
            return (
              <Group
                key={location}
                title={title}
                description={location === "claude-plugin" ? "Installed by Claude plugins. Turn a plugin off or uninstall it under Claude plugins." : location === "other" ? "From pi packages and settings entries." : root ? shortPath(root.path) : undefined}
                items={group}
                cwd={cwd}
                deferred={deferred}
                byPlugin={location === "claude-plugin"}
                onOpenPlugins={onOpenPlugins}
              />
            );
          })}
        </>
      ) : null}
      {view === "skills" ? <NewSkill open={creating} cwd={cwd} onClose={() => setCreating(false)} /> : <NewPrompt open={creating} cwd={cwd} onClose={() => setCreating(false)} />}
    </Stack>
  );
}

/** The mode the deferred extension gives each skill, when it is on. */
function useDeferredModes(cwd: string, enabled: boolean): ((name: string) => DeferredMode | null) | null {
  const { ext } = useExtension("deferred");
  const config = useRpcQuery(deferredConfigRpc, { cwd: cwd || undefined }, { staleTime: 30_000, enabled: enabled && Boolean(ext?.enabled) });
  if (!ext?.enabled || !config.data) return null;
  const rules = config.data.rules;
  return (name) => decide(rules, "skills", name)?.mode ?? null;
}

function Group({
  title,
  description,
  items,
  cwd,
  deferred,
  byPlugin,
  onOpenPlugins,
}: {
  title: string;
  description?: string;
  items: Item[];
  cwd: string;
  deferred: ((name: string) => DeferredMode | null) | null;
  byPlugin: boolean;
  onOpenPlugins?: () => void;
}) {
  const { theme } = useUi();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shown = all ? items : items.slice(0, PAGE);
  const sorted = byPlugin ? [...shown].sort((a, b) => (a.plugin ?? "").localeCompare(b.plugin ?? "") || a.name.localeCompare(b.name)) : shown;
  return (
    <Section
      title={`${title} · ${items.length}`}
      description={description}
      right={byPlugin && onOpenPlugins ? <Button small variant="outline" icon="Store" label="Claude plugins" onPress={onOpenPlugins} /> : undefined}
    >
      <Card padded={false} style={{ gap: 0 }}>
        {sorted.map((item, index) => {
          const header = byPlugin && item.plugin !== sorted[index - 1]?.plugin;
          return (
            <View key={item.path} style={{ borderTopWidth: index && !header ? 1 : 0, borderColor: theme.colors.border }}>
              {header ? (
                <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: theme.colors.surface2, borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
                  <Row gap={6}>
                    <Icon name="Package" size={13} color={theme.colors.foregroundMuted} />
                    <Txt size="xs" weight="600" tone="muted">
                      {item.plugin ?? "Unknown plugin"}
                    </Txt>
                  </Row>
                </View>
              ) : null}
              <ItemRow item={item} cwd={cwd} mode={item.kind === "skills" && deferred ? deferred(item.name) : null} expanded={open === item.path} onToggle={() => setOpen(open === item.path ? null : item.path)} />
            </View>
          );
        })}
      </Card>
      {items.length > PAGE && !all ? <Button small variant="ghost" label={`Show all ${items.length}`} onPress={() => setAll(true)} /> : null}
    </Section>
  );
}

const MODE_TONES: Record<DeferredMode, "muted" | "accent" | "warning" | "danger"> = { on: "muted", names: "accent", deferred: "accent", user: "warning", off: "danger" };

function ItemRow({ item, cwd, mode, expanded, onToggle }: { item: Item; cwd: string; mode: DeferredMode | null; expanded: boolean; onToggle: () => void }) {
  const { theme } = useUi();
  const toggle = useRpcMutation(resourceToggleRpc, {
    invalidates: FILE_QUERIES,
    success: (result) => `Saved ${shortPath(result.path)}. New pi sessions pick it up; running ones need /reload.`,
  });
  const prompt = item.kind === "prompts" ? (item as Prompt) : null;
  const skill = item.kind === "skills" ? (item as Skill) : null;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name}. ${expanded ? "Close" : "Open"}`}
        onPress={onToggle}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({ paddingHorizontal: 14, paddingVertical: 11, backgroundColor: hovered ? theme.colors.surface2 : "transparent" })}
      >
        <Row gap={12} align="flex-start">
          <Icon name={item.kind === "skills" ? "Sparkles" : "SquareSlash"} size={15} color={item.enabled && !item.shadowedBy ? theme.colors.foreground : theme.colors.foregroundMuted} />
          <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
            <Row gap={6} wrap>
              <Txt size="sm" weight="600" mono tone={item.enabled && !item.shadowedBy ? "default" : "muted"}>
                {item.kind === "skills" ? item.name : `/${item.name}`}
              </Txt>
              {prompt?.argumentHint ? (
                <Txt size="xs" tone="muted" mono numberOfLines={1}>
                  {prompt.argumentHint}
                </Txt>
              ) : null}
              {!item.enabled ? <Badge label={!item.toggleable && (item.location === "project" || item.location === "project-agents") ? "workspace not trusted" : "off"} tone={item.toggleable ? "muted" : "warning"} /> : null}
              {item.shadowedBy ? <Badge label="overridden" tone="warning" /> : null}
              {skill?.manualOnly ? <Badge label="manual only" /> : null}
              {mode && mode !== "on" ? <Badge label={`deferred: ${mode}`} tone={MODE_TONES[mode]} /> : null}
              {skill?.warnings.length ? <Badge label={`${skill.warnings.length} warning${skill.warnings.length > 1 ? "s" : ""}`} tone="warning" /> : null}
              {item.source ? <Badge label={item.source} /> : null}
            </Row>
            {item.description ? (
              <Txt size="xs" tone="muted" numberOfLines={expanded ? undefined : 2}>
                {item.description}
              </Txt>
            ) : null}
          </Stack>
          {item.toggleable ? (
            <Switch
              value={item.enabled}
              busy={toggle.isPending}
              label={`${item.enabled ? "Turn off" : "Turn on"} ${item.name}`}
              onChange={(next) => toggle.mutate({ cwd: cwd || undefined, kind: item.kind, path: item.path, enabled: next })}
            />
          ) : null}
        </Row>
      </Pressable>
      {expanded ? <ItemDetail item={item} cwd={cwd} /> : null}
    </View>
  );
}

function ItemDetail({ item, cwd }: { item: Item; cwd: string }) {
  const read = useRpcQuery(resourceReadRpc, { cwd: cwd || undefined, path: item.path }, { staleTime: 5_000 });
  const [confirm, setConfirm] = useState(false);
  const remove = useRpcMutation(skillDeleteRpc, { invalidates: FILE_QUERIES, success: (result) => `Deleted ${shortPath(result.path)}`, onSuccess: () => setConfirm(false) });
  const skill = item.kind === "skills" ? (item as Skill) : null;
  const directory = skill && item.path.endsWith("/SKILL.md");
  return (
    <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
      <Stack gap={10}>
        {skill?.warnings.map((warning) => (
          <Notice key={warning} tone="warning">
            {warning}
          </Notice>
        ))}
        {item.shadowedBy ? <Notice tone="muted">{`pi uses ${shortPath(item.shadowedBy)} instead: it comes first and has the same name.`}</Notice> : null}
        {read.isLoading ? <Spinner /> : null}
        {read.error ? <ErrorBox error={read.error} /> : null}
        {read.data ? (
          <FileCard
            cwd={cwd}
            file={read.data}
            title={item.path.split("/").pop() ?? item.name}
            open={read.data.editable}
            deletable={item.kind === "prompts"}
            minHeight={260}
          />
        ) : null}
        {skill && item.editable ? (
          <Row justify="flex-end">
            <Button small variant="ghost" icon="Trash2" label={directory ? "Delete skill folder" : "Delete skill"} onPress={() => setConfirm(true)} />
          </Row>
        ) : null}
      </Stack>
      <ConfirmModal
        open={confirm}
        title={`Delete ${item.name}?`}
        body={directory ? `This deletes ${shortPath(item.path.replace(/\/SKILL\.md$/, ""))} and everything in it.` : `This deletes ${shortPath(item.path)}.`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate({ cwd: cwd || undefined, path: item.path })}
        onClose={() => setConfirm(false)}
      />
    </View>
  );
}

const NEW_LOCATION_LABELS: Record<NewSkillLocation, string> = {
  agent: "pi (global)",
  "agents-home": "~/.agents (shared)",
  project: "Workspace .pi",
  "project-agents": "Workspace .agents",
};

const NEW_LOCATION_HELP: Record<NewSkillLocation, string> = {
  agent: "In pi's agent directory. Every pi session sees it.",
  "agents-home": "In ~/.agents/skills, which other coding agents read too.",
  project: "In the workspace's .pi/skills. Only sessions here see it.",
  "project-agents": "In the workspace's .agents/skills, which other coding agents read too. Commit it to share it.",
};

function NewSkill({ open, cwd, onClose }: { open: boolean; cwd: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [location, setLocation] = useState<NewSkillLocation>("agent");
  const create = useRpcMutation(skillCreateRpc, {
    invalidates: FILE_QUERIES,
    success: (result) => `Created ${shortPath(result.path)}`,
    onSuccess: () => {
      setName("");
      setDescription("");
      setBody("");
      onClose();
    },
  });
  const nameError = name ? skillNameError(name) : null;
  const locations = NEW_SKILL_LOCATIONS.filter((value) => cwd || (value !== "project" && value !== "project-agents"));
  return (
    <UiModal title="New skill" open={open} onClose={onClose}>
      <Field label="Name" value={name} onChangeText={(value) => setName(value.trim())} placeholder="release-notes" mono error={nameError} hint="Lowercase letters, digits, and hyphens. /skill:name runs it." />
      <Field
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="Drafts release notes from merged pull requests. Use when asked for a changelog or release notes."
        multiline
        minHeight={70}
        hint="The model reads this to decide when to load the skill: say what it does and when to use it."
      />
      <Chips label="Where" options={locations.map((value) => ({ label: NEW_LOCATION_LABELS[value], value }))} value={location} onChange={setLocation} />
      <Txt size="xs" tone="muted">
        {NEW_LOCATION_HELP[location]}
      </Txt>
      <Field label="Instructions" value={body} onChangeText={setBody} placeholder={"# Release notes\n\n1. List the pull requests merged since the last tag.\n2. …"} multiline mono minHeight={180} />
      {create.error ? <ErrorBox error={create.error} /> : null}
      <Row justify="flex-end">
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button
          label="Create skill"
          variant="primary"
          busy={create.isPending}
          disabled={!name || Boolean(nameError) || !description.trim()}
          onPress={() => create.mutate({ cwd: cwd || undefined, location, name, description: description.trim(), body })}
        />
      </Row>
    </UiModal>
  );
}

function NewPrompt({ open, cwd, onClose }: { open: boolean; cwd: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hint, setHint] = useState("");
  const [body, setBody] = useState("");
  const [location, setLocation] = useState<"agent" | "project">("agent");
  const create = useRpcMutation(promptCreateRpc, {
    invalidates: FILE_QUERIES,
    success: (result) => `Created ${shortPath(result.path)}`,
    onSuccess: () => {
      setName("");
      setDescription("");
      setHint("");
      setBody("");
      onClose();
    },
  });
  const nameError = name ? promptNameError(name) : null;
  return (
    <UiModal title="New prompt template" open={open} onClose={onClose}>
      <Field label="Name" value={name} onChangeText={(value) => setName(value.trim())} placeholder="review" mono error={nameError} hint={name && !nameError ? `Runs as /${name}` : "The command name, without the slash."} />
      <Field label="Description" value={description} onChangeText={setDescription} placeholder="Review the staged changes" />
      <Field label="Argument hint" value={hint} onChangeText={setHint} placeholder="[focus area]" mono />
      {cwd ? (
        <Chips
          label="Where"
          options={[
            { label: "pi (global)", value: "agent" as const },
            { label: "This workspace", value: "project" as const },
          ]}
          value={location}
          onChange={setLocation}
        />
      ) : null}
      <Field label="Template" value={body} onChangeText={setBody} placeholder={"Review the staged changes. Focus on $ARGUMENTS.\n\nList bugs first, then style."} multiline mono minHeight={160} hint="$1, $2 are arguments by position; $@ and $ARGUMENTS are all of them; ${1:-default} has a fallback." />
      {create.error ? <ErrorBox error={create.error} /> : null}
      <Row justify="flex-end">
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button
          label="Create prompt"
          variant="primary"
          busy={create.isPending}
          disabled={!name || Boolean(nameError) || !body.trim()}
          onPress={() => create.mutate({ cwd: cwd || undefined, location: cwd ? location : "agent", name, description: description.trim(), argumentHint: hint.trim() || undefined, body })}
        />
      </Row>
    </UiModal>
  );
}
