// The `deferred` extension: its rules from every source, one-tap mode changes, new rules, a check
// of which rule decides a name, its options, and its live status from `/deferred status`.
import type { RpcOutput } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { catalogRpc, extensionCommandRunRpc } from "../shared/contracts";
import {
  DEFERRED_KINDS,
  MODE_HELP,
  decide,
  deferredConfigRpc,
  deferredOptionsRpc,
  deferredSetRpc,
  modesFor,
  type DeferredKind,
  type DeferredMode,
  type Rule,
} from "../shared/deferred";
import { useRpcMutation, useRpcQuery } from "./queries";
import {
  Badge,
  Button,
  Card,
  Chips,
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
  TabBar,
  Txt,
  tint,
  toneColor,
  useUi,
  type Tone,
} from "./ui";

const KIND_LABELS: Record<DeferredKind, string> = { tools: "Tools", skills: "Skills", context: "Context", sections: "Sections" };
const KIND_SINGULAR: Record<DeferredKind, string> = { tools: "tool", skills: "skill", context: "context", sections: "section" };
const KIND_HINTS: Record<DeferredKind, string> = {
  tools: "read, mcp__github__*, mcp__*",
  skills: "commit, release-*, *",
  context: "AGENTS.md, docs/AGENTS.md",
  sections: "mcp_servers",
};
const MODE_TONES: Record<DeferredMode, Tone> = { on: "success", names: "accent", deferred: "warning", user: "accent", off: "danger" };
const INVALIDATES = ["deferred.config"] as const;

type Scope = "global" | "project" | "repo";

function scopeLabel(rule: Pick<Rule, "scope" | "repo">): string {
  return rule.scope === "repo" ? `repo ${rule.repo}` : rule.scope === "project" ? "workspace" : "global";
}

/** Small segmented control of the modes a kind allows. */
function ModeSwitch({ kind, value, onChange, disabled }: { kind: DeferredKind; value: DeferredMode; onChange: (mode: DeferredMode) => void; disabled?: boolean }) {
  const { theme } = useUi();
  return (
    <View style={{ flexDirection: "row", borderRadius: 7, padding: 2, gap: 2, backgroundColor: theme.colors.surface0, borderWidth: 1, borderColor: theme.colors.border, opacity: disabled ? 0.55 : 1 }}>
      {modesFor(kind).map((mode) => {
        const active = mode === value;
        const color = toneColor(theme, MODE_TONES[mode]);
        return (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled }}
            accessibilityLabel={`${mode}: ${MODE_HELP[mode]}`}
            disabled={disabled || active}
            onPress={() => onChange(mode)}
            style={{ paddingHorizontal: 7, height: 22, justifyContent: "center", borderRadius: 5, backgroundColor: active ? tint(color, mode === "names" || mode === "user" ? 0.55 : 0.22) : "transparent" }}
          >
            <Txt size="xs" weight={active ? "700" : "500"} tone={active ? (mode === "names" || mode === "user" ? "default" : MODE_TONES[mode]) : "muted"}>
              {mode}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export function DeferredManager({ cwd }: { cwd: string }) {
  const config = useRpcQuery(deferredConfigRpc, { cwd: cwd || undefined }, { staleTime: 10_000 });
  const data = config.data;
  return (
    <Stack gap={20}>
      {config.isLoading ? <Spinner label="Reading the deferred rules" /> : null}
      {config.error ? <ErrorBox error={config.error} /> : null}
      {data ? (
        <>
          <Overview data={data} cwd={cwd} />
          <CheckName rules={data.rules} />
          <Rules data={data} cwd={cwd} />
          <AddRule data={data} cwd={cwd} />
        </>
      ) : null}
    </Stack>
  );
}

type Config = RpcOutput<typeof deferredConfigRpc>;

function Overview({ data, cwd }: { data: Config; cwd: string }) {
  const [auto, setAuto] = useState(data.auto === false ? "" : String(data.auto));
  const [maxResults, setMaxResults] = useState(String(data.maxResults));
  const [status, setStatus] = useState<string | null>(null);
  const save = useRpcMutation(deferredOptionsRpc, { invalidates: INVALIDATES, success: "Saved. Running pi sessions apply it on /deferred reload." });
  const run = useRpcMutation(extensionCommandRunRpc, {
    onSuccess: (result) => setStatus(result.output.map((notice) => notice.text).join("\n\n") || "No output."),
  });
  const counts = DEFERRED_KINDS.map((kind) => ({ kind, count: data.rules.filter((rule) => rule.kind === kind).length }));
  const autoNumber = auto.trim() === "" ? false : Number(auto);
  const autoInvalid = autoNumber !== false && (!Number.isFinite(autoNumber) || autoNumber < 0 || autoNumber > 100);
  const maxNumber = Number(maxResults);
  const maxInvalid = !Number.isInteger(maxNumber) || maxNumber < 1 || maxNumber > 50;
  const dirty = (autoNumber === false ? data.auto !== false : autoNumber !== data.auto) || maxNumber !== data.maxResults;
  return (
    <Card style={{ gap: 12 }}>
      <Row justify="space-between" wrap gap={8}>
        <Stack gap={2} style={{ flexShrink: 1 }}>
          <Txt weight="600">Deferred loading</Txt>
          <Txt size="sm" tone="muted">
            Keeps tools, skills, context files, and prompt sections out of the system prompt until the model loads them with deferred_search.
          </Txt>
        </Stack>
        <Button small variant="outline" icon="Activity" label="/deferred status" busy={run.isPending} onPress={() => run.mutate({ cwd: cwd || undefined, command: "deferred", args: "status" })} />
      </Row>
      <Row gap={6} wrap>
        {counts.map(({ kind, count }) => (
          <Badge key={kind} label={`${count} ${KIND_SINGULAR[kind]} rule${count === 1 ? "" : "s"}`} />
        ))}
        {data.repo ? <Badge label={`repo ${data.repo}`} icon="GitBranch" /> : null}
        {cwd ? <Badge label={data.trusted ? "workspace trusted" : "workspace not trusted"} tone={data.trusted ? "success" : "warning"} /> : null}
      </Row>
      {data.warnings.map((warning) => (
        <Txt key={warning} size="xs" tone="warning">
          {`• ${warning}`}
        </Txt>
      ))}
      <Row gap={10} wrap align="flex-end">
        <View style={{ width: 150 }}>
          <Field label="auto (% of context)" value={auto} onChangeText={setAuto} placeholder="off" error={autoInvalid ? "0 to 100, or empty for off" : null} />
        </View>
        <View style={{ width: 150 }}>
          <Field label="maxResults" value={maxResults} onChangeText={setMaxResults} error={maxInvalid ? "1 to 50" : null} />
        </View>
        <Button
          label="Save options"
          variant="primary"
          disabled={!dirty || autoInvalid || maxInvalid}
          busy={save.isPending}
          onPress={() => save.mutate({ auto: autoNumber === false || autoNumber === 0 ? false : autoNumber, maxResults: maxNumber })}
        />
      </Row>
      <Txt size="xs" tone="muted">
        Tools no rule matches become names when their schemas take more than auto percent of the context of the model. Options save to the global settings.
      </Txt>
      {status !== null ? (
        <Stack gap={6}>
          <Row justify="space-between">
            <Txt size="sm" weight="600">
              /deferred status
            </Txt>
            <IconButton icon="X" label="Hide the status" onPress={() => setStatus(null)} />
          </Row>
          <CodeBlock text={status} maxHeight={320} />
        </Stack>
      ) : null}
    </Card>
  );
}

function CheckName({ rules }: { rules: Rule[] }) {
  const [kind, setKind] = useState<DeferredKind>("tools");
  const [name, setName] = useState("");
  const rule = name.trim() ? decide(rules, kind, name.trim()) : null;
  const mode: DeferredMode = rule?.mode ?? "on";
  return (
    <Section title="Check a name" description="Which rule decides a tool, skill, context file, or section; the last matching rule wins.">
      <Card style={{ gap: 10 }}>
        <Chips options={DEFERRED_KINDS.map((k) => ({ label: KIND_LABELS[k], value: k }))} value={kind} onChange={setKind} />
        <Field value={name} onChangeText={setName} placeholder={kind === "context" ? "/path/to/AGENTS.md" : kind === "tools" ? "mcp__github__create_issue" : "a name"} mono />
        {name.trim() ? (
          <Row gap={8} wrap>
            <Badge label={mode} tone={MODE_TONES[mode]} />
            <Txt size="sm">{rule ? `rule ${rule.pattern} (${scopeLabel(rule)}${rule.origin === "file" ? ", deferred.json" : ""})` : "No rule matches: pi loads it as usual."}</Txt>
            {!rule && kind === "tools" ? (
              <Txt size="xs" tone="muted">
                An extension or MCP tool can still become names through auto.
              </Txt>
            ) : null}
          </Row>
        ) : null}
      </Card>
    </Section>
  );
}

const PAGE = 60;

function Rules({ data, cwd }: { data: Config; cwd: string }) {
  const { theme } = useUi();
  const [kind, setKind] = useState<DeferredKind>("tools");
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<"all" | Scope>("all");
  const [limit, setLimit] = useState(PAGE);
  const set = useRpcMutation(deferredSetRpc, { invalidates: INVALIDATES });
  const words = filter.trim().toLowerCase();
  const rules = data.rules.filter((rule) => rule.kind === kind && (scope === "all" || rule.scope === scope) && (!words || rule.pattern.toLowerCase().includes(words)));
  // The rule that wins for a pattern is the last one in precedence order.
  const shown = useMemo(() => [...rules].reverse(), [rules]);
  const tabs = DEFERRED_KINDS.map((k) => ({ id: k, label: KIND_LABELS[k], badge: data.rules.filter((rule) => rule.kind === k).length || undefined, badgeTone: "muted" as Tone }));
  const change = (rule: Rule, mode: DeferredMode | null) =>
    set.mutate({ cwd: cwd || undefined, scope: rule.scope, repo: rule.repo ?? undefined, kind: rule.kind, pattern: rule.pattern, mode });
  return (
    <Section title="Rules" description="Rules that win come first. Tap a mode to change a rule; new pi sessions use it, and running ones after /deferred reload.">
      <TabBar tabs={tabs} value={kind} onChange={(next) => { setKind(next); setLimit(PAGE); }} />
      <Row gap={10} wrap>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field value={filter} onChangeText={setFilter} placeholder={`Filter ${KIND_LABELS[kind].toLowerCase()} patterns`} />
        </View>
        <Chips
          options={[
            { label: "All", value: "all" as const },
            { label: "Global", value: "global" as const },
            { label: "Workspace", value: "project" as const },
            { label: "Repo", value: "repo" as const },
          ]}
          value={scope}
          onChange={setScope}
        />
      </Row>
      {set.error ? <ErrorBox error={set.error} /> : null}
      {shown.length === 0 ? (
        <Card>
          <Empty icon="Layers" title={`No ${KIND_LABELS[kind].toLowerCase()} rules${words || scope !== "all" ? " match" : ""}`} body="Everything without a rule loads as usual." />
        </Card>
      ) : (
        <Card padded={false} style={{ gap: 0 }}>
          {shown.slice(0, limit).map((rule, index) => {
            const editable = rule.origin === "settings";
            const busy = set.isPending && set.variables?.pattern === rule.pattern && set.variables?.kind === rule.kind && set.variables?.scope === rule.scope;
            return (
              <Row
                key={`${rule.scope}:${rule.repo}:${rule.origin}:${rule.pattern}`}
                gap={10}
                wrap
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border, opacity: rule.applies ? 1 : 0.55 }}
              >
                <Stack gap={1} style={{ flex: 1, minWidth: 180 }}>
                  <Txt size="sm" mono numberOfLines={1}>
                    {rule.pattern}
                  </Txt>
                  <Row gap={4}>
                    <Txt size="xs" tone="muted">
                      {scopeLabel(rule)}
                    </Txt>
                    {rule.origin === "file" ? <Badge label="deferred.json · read-only" /> : null}
                    {!rule.applies ? <Badge label="not active here" tone="warning" /> : null}
                  </Row>
                </Stack>
                <ModeSwitch kind={rule.kind} value={rule.mode} disabled={!editable || busy} onChange={(mode) => change(rule, mode)} />
                <IconButton icon="Trash2" label={`Remove ${rule.pattern}`} tone="danger" disabled={!editable || busy} onPress={() => change(rule, null)} />
              </Row>
            );
          })}
          {shown.length > limit ? (
            <View style={{ padding: 10, borderTopWidth: 1, borderColor: theme.colors.border, alignItems: "center" }}>
              <Button small variant="ghost" label={`Show ${Math.min(PAGE, shown.length - limit)} more of ${shown.length - limit}`} onPress={() => setLimit(limit + PAGE)} />
            </View>
          ) : null}
        </Card>
      )}
    </Section>
  );
}

function AddRule({ data, cwd }: { data: Config; cwd: string }) {
  const catalog = useRpcQuery(catalogRpc, { cwd: cwd || undefined }, { staleTime: 120_000 });
  const [kind, setKind] = useState<DeferredKind>("tools");
  const [pattern, setPattern] = useState("");
  const [mode, setMode] = useState<DeferredMode>("names");
  const [scope, setScope] = useState<Scope>("global");
  const add = useRpcMutation(deferredSetRpc, {
    invalidates: INVALIDATES,
    success: (result) => `Saved to ${result.path}`,
    onSuccess: () => setPattern(""),
  });
  const suggestions = useMemo(() => {
    const words = pattern.trim().toLowerCase();
    const all =
      kind === "skills"
        ? (catalog.data?.skills ?? [])
        : kind === "tools"
          ? ["mcp__*", ...(catalog.data?.mcpServers ?? []).map((server) => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__*`), ...(catalog.data?.tools ?? [])]
          : kind === "context"
            ? ["AGENTS.md", "CLAUDE.md"]
            : ["mcp_servers"];
    return all.filter((item) => !words || item.toLowerCase().includes(words)).slice(0, 10);
  }, [catalog.data, kind, pattern]);
  const scopes: { label: string; value: Scope }[] = [{ label: "Global", value: "global" }];
  if (cwd) scopes.push({ label: "This workspace", value: "project" });
  if (data.repo) scopes.push({ label: `Repo ${data.repo}`, value: "repo" });
  const valid = pattern.trim().length > 0 && !/\s/.test(pattern.trim()) && (mode !== "user" || kind === "skills");
  return (
    <Section title="Add a rule">
      <Card style={{ gap: 12 }}>
        <Chips
          label="Kind"
          options={DEFERRED_KINDS.map((k) => ({ label: KIND_LABELS[k], value: k }))}
          value={kind}
          onChange={(next) => {
            setKind(next);
            if (next !== "skills" && mode === "user") setMode("names");
          }}
        />
        <Field label="Pattern" value={pattern} onChangeText={setPattern} placeholder={KIND_HINTS[kind]} mono hint="* matches any run of characters and ? one character." />
        {suggestions.length ? (
          <Row gap={6} wrap>
            {suggestions.map((item) => (
              <Button key={item} small variant="ghost" label={item} onPress={() => setPattern(item)} />
            ))}
          </Row>
        ) : null}
        <Stack gap={6}>
          <Txt size="sm" weight="500">
            Mode
          </Txt>
          <Row gap={10} wrap>
            <ModeSwitch kind={kind} value={mode} onChange={setMode} />
            <Txt size="xs" tone="muted" style={{ flexShrink: 1 }}>
              {MODE_HELP[mode]}
            </Txt>
          </Row>
        </Stack>
        <Chips label="Save to" options={scopes} value={scope} onChange={setScope} />
        {scope === "project" ? (
          <Notice tone={data.trusted ? "muted" : "warning"}>
            {data.trusted
              ? "Saves to this workspace's .pi/settings.json. pi reads it only while it trusts the workspace."
              : "pi does not trust this workspace, so it ignores rules in its .pi/settings.json. Trust it in pi first."}
          </Notice>
        ) : scope === "repo" ? (
          <Notice tone="muted">{`Saves to the global settings under repos.${data.repo}; it applies in every checkout of that repository, worktrees included.`}</Notice>
        ) : null}
        {add.error ? <ErrorBox error={add.error} /> : null}
        <Row justify="flex-end">
          <Button
            label="Add rule"
            variant="primary"
            icon="Plus"
            disabled={!valid || (scope === "project" && !data.trusted)}
            busy={add.isPending}
            onPress={() => add.mutate({ cwd: cwd || undefined, scope, repo: scope === "repo" ? (data.repo ?? undefined) : undefined, kind, pattern: pattern.trim(), mode })}
          />
        </Row>
      </Card>
    </Section>
  );
}
