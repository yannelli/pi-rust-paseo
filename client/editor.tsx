// The workflow editor: every field of the workflow format, the steps as a pipeline beside the
// selected step (stacked on compact layouts), a JSON mode, live validation, and model-written drafts.
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import {
  catalogRpc,
  modelsRpc,
  workflowDraftRpc,
  workflowGetRpc,
  workflowSaveRpc,
  type ScopeName,
} from "../shared/contracts";
import {
  ASK,
  DEFAULT_MODEL,
  CONTEXT_DESCRIPTIONS,
  CONTEXT_MODES,
  THINKING_LEVELS,
  askModels,
  describeTask,
  emptyWorkflow,
  normalizeWorkflow,
  parseDuration,
  parseWorkflow,
  parseWorkflowText,
  slug,
  stepProblems,
  workflowInputs,
  workflowProblems,
  type ContextMode,
  type Scope,
  type Step,
  type SubagentRule,
  type Task,
  type Workflow,
} from "../shared/workflow";
import { useRpcMutation, useRpcQuery } from "./queries";
import {
  Badge,
  Button,
  Card,
  Chips,
  ConfirmModal,
  Divider,
  ErrorBox,
  Field,
  IconButton,
  Notice,
  Row,
  Spinner,
  Stack,
  Toggle,
  Txt,
  errorMessage,
  tint,
  useUi,
} from "./ui";
import { WorkspaceChip, WorkspaceNotices } from "./workspaces";

export type EditorTarget =
  | { kind: "new"; scope: ScopeName; draft?: Record<string, unknown> }
  | { kind: "edit"; name: string; scope: ScopeName };

interface Saved {
  name: string;
  source: ScopeName;
}

interface Options {
  skills: string[];
  mcpServers: string[];
  subagents: string[];
  models: string[];
  tools: string[];
}

const INHERIT = "__inherit";

// Helpers -----------------------------------------------------------------------------------

function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function insertCopy<T>(list: readonly T[], index: number): T[] {
  const next = [...list];
  next.splice(index + 1, 0, structuredClone(list[index]));
  return next;
}

function uniqueStepName(steps: readonly Step[], base: string): string {
  const names = new Set(steps.map((step) => slug(step.name)));
  let n = steps.length + 1;
  let name = `${base}-${n}`;
  while (names.has(slug(name))) name = `${base}-${++n}`;
  return name;
}

function startingWorkflow(target: EditorTarget): { workflow: Workflow; error: string | null } {
  if (target.kind === "new" && target.draft) {
    const parsed = parseWorkflow(target.draft);
    if (parsed.ok) return { workflow: parsed.workflow, error: null };
    return { workflow: emptyWorkflow(), error: `The draft is not a valid workflow: ${parsed.error}` };
  }
  return { workflow: emptyWorkflow(), error: null };
}

function prettyWorkflow(workflow: Workflow): string {
  return JSON.stringify(normalizeWorkflow(workflow), null, 2);
}

function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) env[line] = "";
    else env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return Object.keys(env).length ? env : undefined;
}

function envText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function csv(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Small controls ----------------------------------------------------------------------------

function Pill({ label, onRemove, onPress, active }: { label: string; onRemove?: () => void; onPress?: () => void; active?: boolean }) {
  const { theme } = useUi();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={onRemove ? `Remove ${label}` : label}
      onPress={onRemove ?? onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        height: 24,
        borderRadius: 6,
        backgroundColor: active ? tint(theme.colors.accent, 0.4) : hovered ? theme.colors.surface2 : tint(theme.colors.foregroundMuted, 0.1),
      })}
    >
      {!onRemove && !active ? <Icon name="Plus" size={11} color={theme.colors.foregroundMuted} /> : null}
      <Txt size="xs" mono={label.includes("/") || label.includes("_")} weight="500">
        {label}
      </Txt>
      {onRemove ? <Icon name="X" size={11} color={theme.colors.foreground} /> : null}
    </Pressable>
  );
}

/** A text field whose value is a number or unset; it keeps the typed text while it is invalid. */
function NumberField({ label, value, onChange, integer, hint, placeholder }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; integer?: boolean; hint?: string; placeholder?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const parse = (input: string): number | undefined | null => {
    const trimmed = input.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) return null;
    return n;
  };
  useEffect(() => {
    if (parse(text) !== value) setText(value === undefined ? "" : String(value));
    // Only an outside change of `value` resets the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parsed = parse(text);
  return (
    <Field
      label={label}
      value={text}
      placeholder={placeholder ?? "inherit"}
      hint={hint}
      error={parsed === null ? (integer ? "Enter a whole number." : "Enter a number.") : null}
      onChangeText={(next) => {
        setText(next);
        const n = parse(next);
        if (n !== null) onChange(n);
      }}
    />
  );
}

/** Comma-separated values; empty text is unset. */
function CsvField({ label, value, onChange, placeholder, hint }: { label: string; value: string[] | undefined; onChange: (value: string[] | undefined) => void; placeholder?: string; hint?: string }) {
  const [text, setText] = useState((value ?? []).join(", "));
  return (
    <Field
      label={label}
      value={text}
      placeholder={placeholder}
      hint={hint}
      onChangeText={(next) => {
        setText(next);
        const items = csv(next);
        onChange(items.length ? items : undefined);
      }}
    />
  );
}

/** Text with optional suggestions below it; picking one sets the value. */
function SuggestField({ label, value, onChange, options, placeholder, hint, error }: { label: string; value: string; onChange: (value: string) => void; options: readonly string[]; placeholder?: string; hint?: string; error?: string | null }) {
  const [focused, setFocused] = useState(false);
  const needle = value.trim().toLowerCase();
  const matches = options.filter((option) => option !== value && option.toLowerCase().includes(needle)).slice(0, 8);
  return (
    <Stack gap={4}>
      <Field
        label={label || undefined}
        value={value}
        onChangeText={(next) => {
          setFocused(true);
          onChange(next);
        }}
        placeholder={placeholder}
        hint={hint}
        error={error}
        mono
      />
      {(focused || !value) && matches.length > 0 ? (
        <Row gap={4} wrap>
          {matches.map((option) => (
            <Pill
              key={option}
              label={option}
              onPress={() => {
                setFocused(false);
                onChange(option);
              }}
            />
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}

type ListMode = "inherit" | "none" | "list";

/** A list with three states: inherit (unset), none (`[]`), or chosen items. */
function ListPicker({ label, hint, value, onChange, options, noneLabel = "None" }: { label: string; hint?: string; value: string[] | undefined; onChange: (value: string[] | undefined) => void; options: readonly string[]; noneLabel?: string }) {
  const [choosing, setChoosing] = useState(false);
  const [filter, setFilter] = useState("");
  const mode: ListMode = value === undefined ? "inherit" : value.length === 0 && !choosing ? "none" : "list";
  const selected = value ?? [];
  const needle = filter.trim().toLowerCase();
  const suggestions = options.filter((option) => !selected.includes(option) && option.toLowerCase().includes(needle)).slice(0, 12);
  const add = (item: string) => {
    const trimmed = item.trim();
    if (!trimmed || selected.includes(trimmed)) return;
    onChange([...selected, trimmed]);
    setFilter("");
  };
  return (
    <Stack gap={6}>
      <Chips
        label={label}
        options={[
          { label: "Inherit", value: "inherit" },
          { label: noneLabel, value: "none" },
          { label: "Choose", value: "list" },
        ]}
        value={mode}
        onChange={(next: ListMode) => {
          setChoosing(next === "list");
          if (next === "inherit") onChange(undefined);
          else if (next === "none") onChange([]);
          else onChange(value ?? []);
        }}
      />
      {hint ? (
        <Txt size="xs" tone="muted">
          {hint}
        </Txt>
      ) : null}
      {mode === "list" ? (
        <Stack gap={6}>
          {selected.length ? (
            <Row gap={4} wrap>
              {selected.map((item) => (
                <Pill key={item} label={item} active onRemove={() => onChange(selected.filter((other) => other !== item))} />
              ))}
            </Row>
          ) : (
            <Txt size="xs" tone="muted">
              Nothing chosen yet.
            </Txt>
          )}
          <Field value={filter} onChangeText={setFilter} placeholder="Filter, or type a name or pattern and add it" onSubmit={() => add(filter)} />
          <Row gap={4} wrap>
            {suggestions.map((option) => (
              <Pill key={option} label={option} onPress={() => add(option)} />
            ))}
            {filter.trim() && !options.includes(filter.trim()) && !selected.includes(filter.trim()) ? (
              <Button small variant="ghost" icon="Plus" label={`Add ${filter.trim()}`} onPress={() => add(filter)} />
            ) : null}
          </Row>
        </Stack>
      ) : null}
    </Stack>
  );
}

type ModelMode = "inherit" | "ask" | "model";

function ModelPicker({ label, value, onChange, models, allowAsk = true, inheritHint }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; models: readonly string[]; allowAsk?: boolean; inheritHint: string }) {
  const mode: ModelMode = value === undefined ? "inherit" : value === ASK ? "ask" : "model";
  const options: { label: string; value: ModelMode }[] = [{ label: "Inherit", value: "inherit" }];
  if (allowAsk) options.push({ label: "Ask at run", value: "ask" });
  options.push({ label: "Model", value: "model" });
  const slash = value ? value.indexOf("/") : -1;
  const invalid = mode === "model" && !(slash > 0 && slash < (value ?? "").length - 1) ? "Use provider/id." : null;
  return (
    <Stack gap={6}>
      <Chips
        label={label}
        options={options}
        value={mode}
        onChange={(next: ModelMode) => {
          if (next === "inherit") onChange(undefined);
          else if (next === "ask") onChange(ASK);
          else if (mode !== "model") onChange(DEFAULT_MODEL);
        }}
      />
      {mode === "inherit" ? (
        <Txt size="xs" tone="muted">
          {inheritHint}
        </Txt>
      ) : mode === "ask" ? (
        <Txt size="xs" tone="muted">
          The run dialog asks for this model when the run starts.
        </Txt>
      ) : (
        <SuggestField label="" value={value ?? ""} onChange={(next) => onChange(next)} options={models} placeholder="provider/model-id" error={invalid} />
      )}
    </Stack>
  );
}

function ThinkingPicker({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  return (
    <Chips
      label="Thinking"
      options={[{ label: "Inherit", value: INHERIT }, ...THINKING_LEVELS.map((level) => ({ label: level, value: level as string }))]}
      value={value ?? INHERIT}
      onChange={(next: string) => onChange(next === INHERIT ? undefined : next)}
    />
  );
}

function EnvEditor({ value, onChange }: { value: Record<string, string> | undefined; onChange: (value: Record<string, string> | undefined) => void }) {
  const [text, setText] = useState(() => envText(value));
  return (
    <Field
      label="Environment"
      value={text}
      onChangeText={(next) => {
        setText(next);
        onChange(parseEnv(next));
      }}
      placeholder={"KEY=value\nDATABASE_URL=${STAGING_DATABASE_URL}"}
      hint="One KEY=value per line. ${NAME} reads the environment of the runner, so secrets stay out of the file."
      multiline
      mono
      minHeight={70}
    />
  );
}

function SubagentRules({ value, onChange, subagents, models }: { value: SubagentRule[] | undefined; onChange: (value: SubagentRule[] | undefined) => void; subagents: readonly string[]; models: readonly string[] }) {
  const [choosing, setChoosing] = useState(false);
  const mode: ListMode = value === undefined ? "inherit" : value.length === 0 && !choosing ? "none" : "list";
  const rules = value ?? [];
  const update = (index: number, rule: SubagentRule) => onChange(rules.map((other, i) => (i === index ? rule : other)));
  return (
    <Stack gap={6}>
      <Chips
        label="Subagents"
        options={[
          { label: "Inherit", value: "inherit" },
          { label: "No subagent tool", value: "none" },
          { label: "Rules", value: "list" },
        ]}
        value={mode}
        onChange={(next: ListMode) => {
          setChoosing(next === "list");
          if (next === "inherit") onChange(undefined);
          else if (next === "none") onChange([]);
          else onChange(value && value.length ? value : [{ agent: subagents[0] ?? "explore" }]);
        }}
      />
      {mode === "list" ? (
        <Stack gap={6}>
          <Txt size="xs" tone="muted">
            Only these agent types may start. The first model without * and the first thinking level are the defaults.
          </Txt>
          {rules.map((rule, index) => (
            <Card key={index}>
              <Row justify="space-between">
                <Txt size="sm" weight="600">
                  Rule {index + 1}
                </Txt>
                <IconButton icon="Trash2" label={`Remove subagent rule ${index + 1}`} tone="danger" onPress={() => onChange(rules.filter((_, i) => i !== index))} />
              </Row>
              <SuggestField label="Agent type" value={rule.agent} onChange={(agent) => update(index, { ...rule, agent })} options={subagents} placeholder="explore" />
              <CsvField
                label="Models"
                value={rule.models}
                onChange={(list) => update(index, { ...rule, models: list })}
                placeholder={`${DEFAULT_MODEL}, anthropic/*`}
                hint="Comma-separated; * matches any text. Empty allows every model."
              />
              <Stack gap={4}>
                <Txt size="sm" weight="600">
                  Thinking levels
                </Txt>
                <Row gap={4} wrap>
                  {THINKING_LEVELS.map((level) => {
                    const on = (rule.thinking ?? []).includes(level);
                    return (
                      <Pill
                        key={level}
                        label={level}
                        active={on}
                        onPress={() => {
                          const current = rule.thinking ?? [];
                          const next = on ? current.filter((item) => item !== level) : [...current, level];
                          update(index, { ...rule, thinking: next.length ? next : undefined });
                        }}
                      />
                    );
                  })}
                </Row>
              </Stack>
            </Card>
          ))}
          <Row>
            <Button small icon="Plus" label="Add rule" onPress={() => onChange([...rules, { agent: "" }])} />
          </Row>
        </Stack>
      ) : null}
    </Stack>
  );
}

function scopeSummary(scope: Scope | undefined): string {
  if (!scope) return "inherits everything";
  const parts: string[] = [];
  if (scope.model) parts.push(scope.model === ASK ? "model asked at run" : scope.model);
  if (scope.thinking) parts.push(`thinking ${scope.thinking}`);
  if (scope.tools) parts.push(scope.tools.length ? `${scope.tools.length} tools` : "no tools");
  if (scope.skills) parts.push(scope.skills.length ? `${scope.skills.length} skills` : "no skills");
  if (scope.mcp) parts.push(scope.mcp.length ? `${scope.mcp.length} MCP` : "no MCP");
  if (scope.subagents) parts.push(scope.subagents.length ? `${scope.subagents.length} subagent rules` : "no subagents");
  if (scope.env && Object.keys(scope.env).length) parts.push(`${Object.keys(scope.env).length} env`);
  if (scope.maxTurns) parts.push(`≤${scope.maxTurns} turns`);
  if (scope.maxCost) parts.push(`≤$${scope.maxCost}`);
  return parts.length ? parts.join(" · ") : "inherits everything";
}


// Layout --------------------------------------------------------------------------------------

/** A card with an icon tile, a title, and an optional subtitle and right-hand control. */
function Panel({ icon, title, subtitle, right, children }: { icon: string; title: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  const { theme } = useUi();
  return (
    <Card style={{ gap: 14 }}>
      <Row gap={10} justify="space-between" align="center">
        <Row gap={10} style={{ flex: 1 }}>
          <View style={{ width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
            <Icon name={icon} size={15} color={theme.colors.foreground} />
          </View>
          <Stack gap={0} style={{ flex: 1 }}>
            <Txt size="md" weight="600">
              {title}
            </Txt>
            {subtitle ? (
              <Txt size="xs" tone="muted" numberOfLines={2}>
                {subtitle}
              </Txt>
            ) : null}
          </Stack>
        </Row>
        {right}
      </Row>
      {children}
    </Card>
  );
}

/** A labeled group inside a panel, separated from the one above by a rule. */
function Group({ title, first, children }: { title?: string; first?: boolean; children: ReactNode }) {
  return (
    <Stack gap={12}>
      {first ? null : <Divider />}
      {title ? (
        <Txt size="xs" weight="600" tone="muted">
          {title.toUpperCase()}
        </Txt>
      ) : null}
      {children}
    </Stack>
  );
}

/** Agent settings of the workflow or one step. Unset fields inherit. */
function ScopeEditor({ scope, onChange, options, level }: { scope: Scope | undefined; onChange: (scope: Scope | undefined) => void; options: Options; level: "workflow" | "step" }) {
  const { compact } = useUi();
  const value = scope ?? {};
  const set = <K extends keyof Scope>(key: K, next: Scope[K]) => {
    const updated: Scope = { ...value, [key]: next };
    if (next === undefined) delete updated[key];
    onChange(Object.keys(updated).length ? updated : undefined);
  };
  const inherit = level === "workflow" ? "Steps use pi's default model, from the session that starts the run." : "The workflow default, else pi's default model.";
  return (
    <Stack gap={16}>
      <Group first>
        <ModelPicker label="Model" value={value.model} onChange={(model) => set("model", model)} models={options.models} inheritHint={inherit} />
        <ThinkingPicker value={value.thinking} onChange={(thinking) => set("thinking", thinking)} />
      </Group>
      <Group title="Capabilities">
        <ListPicker label="Tools" value={value.tools} onChange={(tools) => set("tools", tools)} options={options.tools} hint="Tool names or * patterns. Inherit: pi's default tools." noneLabel="No tools" />
        <ListPicker label="Skills" value={value.skills} onChange={(skills) => set("skills", skills)} options={options.skills} hint="Inherit: all skills. Skills that tasks run always load." noneLabel="No skills" />
        <ListPicker label="MCP servers" value={value.mcp} onChange={(mcp) => set("mcp", mcp)} options={options.mcpServers} hint="Inherit: all servers." noneLabel="No MCP" />
        <SubagentRules value={value.subagents} onChange={(subagents) => set("subagents", subagents)} subagents={options.subagents} models={options.models} />
      </Group>
      <Group title="Environment and limits">
        <EnvEditor value={value.env} onChange={(env) => set("env", env)} />
        <Field
          label="System prompt"
          value={value.systemPrompt ?? ""}
          onChangeText={(text) => set("systemPrompt", text.length ? text : undefined)}
          placeholder="Text added to the agent's system prompt"
          multiline
          minHeight={60}
        />
        <View style={{ flexDirection: compact ? "column" : "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <NumberField label="Max turns" value={value.maxTurns} onChange={(n) => set("maxTurns", n)} integer hint="Per task run" />
          </View>
          <View style={{ flex: 1 }}>
            <NumberField label="Max cost (USD)" value={value.maxCost} onChange={(n) => set("maxCost", n)} hint="Per session" />
          </View>
        </View>
      </Group>
    </Stack>
  );
}

// Tasks and steps ---------------------------------------------------------------------------

function DurationField({ label, value, onChange, hint }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; hint: string }) {
  const invalid = value !== undefined && parseDuration(value) === null;
  return (
    <Field
      label={label}
      value={value ?? ""}
      onChangeText={(text) => onChange(text.trim().length ? text.trim() : undefined)}
      placeholder="30s, 5m, 1h30m"
      hint={hint}
      error={invalid ? "Not a duration such as 30s, 5m, or 1h30m." : null}
    />
  );
}

/** A task feature as a chip: active when set; pressing an active chip clears it. */
function FeatureChip({ icon, label, value, active, tone = "accent", onPress }: { icon: string; label: string; value?: string; active: boolean; tone?: "accent" | "warning"; onPress: () => void }) {
  const { theme } = useUi();
  const color = tone === "warning" ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: active }}
      accessibilityLabel={value ? `${label}: ${value}` : label}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 26,
        paddingHorizontal: 9,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: active ? tint(color, 0.6) : "transparent",
        backgroundColor: active ? tint(color, tone === "warning" ? 0.16 : 0.3) : hovered ? theme.colors.surface2 : tint(theme.colors.foregroundMuted, 0.1),
      })}
    >
      <Icon name={icon} size={12} color={active ? (tone === "warning" ? color : theme.colors.foreground) : theme.colors.foregroundMuted} />
      <Txt size="xs" weight="600" tone={active ? (tone === "warning" ? "warning" : "default") : "muted"}>
        {label}
      </Txt>
      {value ? (
        <Txt size="xs" tone={tone === "warning" ? "warning" : "default"} numberOfLines={1} style={{ maxWidth: 140, opacity: 0.85 }}>
          {value}
        </Txt>
      ) : null}
    </Pressable>
  );
}

type Feature = "delay" | "repeat" | "every" | "until" | "skill";

function TaskEditor({
  task,
  index,
  count,
  skills,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: {
  task: Task;
  index: number;
  count: number;
  skills: readonly string[];
  onChange: (task: Task) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { theme, compact } = useUi();
  const [shown, setShown] = useState<Set<Feature>>(() => new Set((["delay", "repeat", "every", "until", "skill"] as const).filter((key) => task[key] !== undefined)));
  const set = <K extends keyof Task>(key: K, next: Task[K]) => {
    const updated: Task = { ...task, [key]: next };
    if (next === undefined) delete updated[key];
    onChange(updated);
  };
  const toggleFeature = (feature: Feature) => {
    const next = new Set(shown);
    if (shown.has(feature) || task[feature] !== undefined) {
      next.delete(feature);
      set(feature, undefined);
    } else next.add(feature);
    setShown(next);
  };
  const visible = (feature: Feature) => shown.has(feature) || task[feature] !== undefined;
  const summary = describeTask(task);
  const fields: ReactNode[] = [];
  if (visible("delay")) fields.push(<DurationField key="delay" label="Wait first" value={task.delay} onChange={(delay) => set("delay", delay)} hint="Before the first run" />);
  if (visible("repeat"))
    fields.push(
      <NumberField
        key="repeat"
        label="Runs"
        value={task.repeat}
        onChange={(repeat) => set("repeat", repeat)}
        integer
        placeholder={task.until ? "10" : "1"}
        hint={task.until ? "Most runs until the goal" : "How many times it runs"}
      />,
    );
  if (visible("every")) fields.push(<DurationField key="every" label="Every" value={task.every} onChange={(every) => set("every", every)} hint={task.until ? "Between runs (default 1m)" : "Between runs"} />);
  if (visible("skill"))
    fields.push(
      <SuggestField key="skill" label="Skill" value={task.skill ?? ""} onChange={(skill) => set("skill", skill.length ? skill : undefined)} options={skills} placeholder="Runs the prompt as /skill:NAME" />,
    );
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, backgroundColor: theme.colors.surface0, padding: compact ? 10 : 12, gap: 10 }}>
      <Row justify="space-between">
        <Row gap={8} style={{ flex: 1 }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
            <Txt size="xs" weight="700">
              {index + 1}
            </Txt>
          </View>
          <Txt size="sm" weight="600">
            {`Task ${index + 1}`}
          </Txt>
          {summary && compact ? null : (
            <Txt size="xs" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {summary}
            </Txt>
          )}
        </Row>
        <Row gap={0}>
          <IconButton icon="ArrowUp" label={`Move task ${index + 1} up`} disabled={index === 0} onPress={() => onMove(index - 1)} />
          <IconButton icon="ArrowDown" label={`Move task ${index + 1} down`} disabled={index === count - 1} onPress={() => onMove(index + 1)} />
          <IconButton icon="Copy" label={`Duplicate task ${index + 1}`} onPress={onDuplicate} />
          <IconButton icon="Trash2" label={`Delete task ${index + 1}`} tone="danger" disabled={count <= 1} onPress={onDelete} />
        </Row>
      </Row>
      <Field
        value={task.prompt}
        onChangeText={(prompt) => set("prompt", prompt)}
        placeholder="What to do. {{name}} placeholders become inputs at run time."
        multiline
        minHeight={84}
      />
      <Row gap={6} wrap>
        <FeatureChip icon="Clock" label="Wait" value={task.delay} active={visible("delay")} onPress={() => toggleFeature("delay")} />
        <FeatureChip icon="Repeat" label="Repeat" value={task.repeat !== undefined ? `${task.repeat}×` : undefined} active={visible("repeat")} onPress={() => toggleFeature("repeat")} />
        <FeatureChip icon="Timer" label="Every" value={task.every} active={visible("every")} onPress={() => toggleFeature("every")} />
        <FeatureChip icon="Target" label="Until goal" active={visible("until")} onPress={() => toggleFeature("until")} />
        <FeatureChip icon="BookOpen" label="Skill" value={task.skill} active={visible("skill")} onPress={() => toggleFeature("skill")} />
        <FeatureChip icon="Hand" label="Approval" tone="warning" active={Boolean(task.confirm)} onPress={() => set("confirm", task.confirm ? undefined : true)} />
        <FeatureChip icon="ShieldOff" label="Optional" active={Boolean(task.optional)} onPress={() => set("optional", task.optional ? undefined : true)} />
      </Row>
      {fields.length ? (
        <View style={{ flexDirection: compact ? "column" : "row", flexWrap: "wrap", gap: 10 }}>
          {fields.map((field, i) => (
            <View key={i} style={{ flexGrow: 1, flexBasis: compact ? undefined : 180 }}>
              {field}
            </View>
          ))}
        </View>
      ) : null}
      {visible("until") ? (
        <Field
          label="Until"
          value={task.until ?? ""}
          onChangeText={(until) => set("until", until.length ? until : undefined)}
          placeholder="A goal: the task runs again until the agent reports it met"
        />
      ) : null}
      {task.confirm ? (
        <Txt size="xs" tone="warning">
          The run waits here until someone approves the task in Paseo or pi.
        </Txt>
      ) : null}
      {task.optional ? (
        <Txt size="xs" tone="muted">
          A failure skips the rest of this task; the workflow goes on.
        </Txt>
      ) : null}
    </View>
  );
}

function StepDetail({ step, index, options, onChange }: { step: Step; index: number; options: Options; onChange: (step: Step) => void }) {
  const setTasks = (tasks: Task[]) => onChange({ ...step, tasks });
  return (
    <Stack gap={14}>
      <Panel icon="Box" title={`Step ${index + 1}`} subtitle="One pi agent runs this step's tasks in one session.">
        <Field label="Name" value={step.name} onChangeText={(name) => onChange({ ...step, name })} hint={step.name && slug(step.name) !== step.name ? `Runs as ${slug(step.name)}` : undefined} />
        <Chips
          label="Context"
          options={[{ label: "Inherit", value: INHERIT }, ...CONTEXT_MODES.map((mode) => ({ label: mode, value: mode as string }))]}
          value={step.context ?? INHERIT}
          onChange={(next: string) => {
            const updated: Step = { ...step };
            if (next === INHERIT) delete updated.context;
            else updated.context = next as ContextMode;
            onChange(updated);
          }}
        />
        <Txt size="xs" tone="muted">
          {step.context ? CONTEXT_DESCRIPTIONS[step.context] : "Uses the workflow's context."}
        </Txt>
      </Panel>
      <Panel
        icon="ListChecks"
        title={`Tasks · ${step.tasks.length}`}
        subtitle="They run in order in one session, so later tasks see the earlier ones."
        right={<Button small icon="Plus" label="Task" onPress={() => setTasks([...step.tasks, { prompt: "" }])} />}
      >
        {step.tasks.map((task, taskIndex) => (
          <TaskEditor
            key={`${index}-${taskIndex}`}
            task={task}
            index={taskIndex}
            count={step.tasks.length}
            skills={options.skills}
            onChange={(next) => setTasks(step.tasks.map((other, i) => (i === taskIndex ? next : other)))}
            onMove={(to) => setTasks(move(step.tasks, taskIndex, to))}
            onDuplicate={() => setTasks(insertCopy(step.tasks, taskIndex))}
            onDelete={() => setTasks(step.tasks.filter((_, i) => i !== taskIndex))}
          />
        ))}
      </Panel>
      <Panel icon="Bot" title="Agent" subtitle={`This step: ${scopeSummary(step.agent)}. Unset fields inherit the workflow defaults.`}>
        <ScopeEditor key={`step-${index}`} scope={step.agent} onChange={(agent) => onChange({ ...step, agent })} options={options} level="step" />
      </Panel>
    </Stack>
  );
}

function WorkflowSettings({ workflow, options, onChange }: { workflow: Workflow; options: Options; onChange: (workflow: Workflow) => void }) {
  const mode = workflow.mode ?? "fixed";
  const context = workflow.context ?? "handoff";
  const planner = workflow.planner ?? {};
  const setPlanner = (next: typeof planner) => {
    const cleaned = { ...next };
    for (const key of Object.keys(cleaned) as (keyof typeof cleaned)[]) if (cleaned[key] === undefined) delete cleaned[key];
    onChange({ ...workflow, planner: Object.keys(cleaned).length ? cleaned : undefined });
  };
  return (
    <Stack gap={14}>
      <Panel icon="Workflow" title="Workflow" subtitle="How the steps run and what each agent learns from the earlier ones.">
        <Field
          label="Description"
          value={workflow.description ?? ""}
          onChangeText={(description) => onChange({ ...workflow, description: description.length ? description : undefined })}
          placeholder="What the workflow does. Every step agent sees it."
          multiline
          minHeight={64}
        />
        <Chips
          label="Mode"
          options={[
            { label: "Fixed", value: "fixed" },
            { label: "Dynamic", value: "dynamic" },
          ]}
          value={mode}
          onChange={(next: "fixed" | "dynamic") => onChange({ ...workflow, mode: next === "dynamic" ? "dynamic" : undefined })}
        />
        <Txt size="xs" tone="muted">
          {mode === "fixed"
            ? "Runs the steps as written."
            : "A planner model writes the remaining steps before each step, from the goal input, the reports so far, and the written steps as a starting plan."}
        </Txt>
        <Chips label="Context" options={CONTEXT_MODES.map((value) => ({ label: value, value }))} value={context} onChange={(next: ContextMode) => onChange({ ...workflow, context: next === "handoff" ? undefined : next })} />
        <Txt size="xs" tone="muted">
          {CONTEXT_DESCRIPTIONS[context]}
        </Txt>
        <Toggle
          label="Background by default"
          hint="Runs keep going after the pi or plugin that started them stops."
          value={Boolean(workflow.background)}
          onChange={(on) => onChange({ ...workflow, background: on ? true : undefined })}
        />
      </Panel>
      {mode === "dynamic" ? (
        <Panel icon="Route" title="Planner" subtitle="Writes the remaining steps before each step.">
          <Field
            label="Instructions"
            value={planner.instructions ?? ""}
            onChangeText={(instructions) => setPlanner({ ...planner, instructions: instructions.length ? instructions : undefined })}
            placeholder="Rules for the plan"
            multiline
            minHeight={60}
          />
          <ModelPicker label="Planner model" value={planner.model} onChange={(model) => setPlanner({ ...planner, model })} models={options.models} allowAsk={false} inheritHint="pi's default model." />
          <NumberField label="Max steps" value={planner.maxSteps} onChange={(maxSteps) => setPlanner({ ...planner, maxSteps })} integer placeholder="12" />
        </Panel>
      ) : null}
      <Panel icon="Bot" title="Default agent" subtitle={`Every step uses these unless it sets its own: ${scopeSummary(workflow.agent)}.`}>
        <ScopeEditor key="workflow" scope={workflow.agent} onChange={(agent) => onChange({ ...workflow, agent })} options={options} level="workflow" />
      </Panel>
    </Stack>
  );
}

/** `anthropic/claude-opus-5-5` → `claude-opus-5-5`. */
function shortModel(model: string | undefined, fallback: string): string {
  if (!model) return fallback;
  if (model === ASK) return "asks at run";
  return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}

function RailNode({ first, last, selected, children, label }: { first: boolean; last: boolean; selected: boolean; children: ReactNode; label: ReactNode }) {
  const { theme } = useUi();
  const line = theme.colors.border;
  return (
    <View style={{ width: 28, alignItems: "center", alignSelf: "stretch" }}>
      <View style={{ width: 2, height: 12, backgroundColor: first ? "transparent" : line }} />
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
          borderWidth: 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
        }}
      >
        {children ?? label}
      </View>
      <View style={{ width: 2, flex: 1, minHeight: 8, backgroundColor: last ? "transparent" : line }} />
    </View>
  );
}

function StepRail({
  workflow,
  selected,
  onSelect,
  onChange,
}: {
  workflow: Workflow;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onChange: (steps: Step[], select?: number | null) => void;
}) {
  const { theme } = useUi();
  const steps = workflow.steps;
  const workflowModel = shortModel(workflow.agent?.model, "pi's default model");
  const row = (active: boolean): ((state: { pressed: boolean; hovered?: boolean }) => object) => ({ hovered }) => ({
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginVertical: 4,
    borderRadius: 10,
    gap: 3,
    backgroundColor: active ? tint(theme.colors.accent, 0.16) : hovered ? theme.colors.surface2 : "transparent",
    borderWidth: 1,
    borderColor: active ? tint(theme.colors.accent, 0.5) : "transparent",
  });
  return (
    <Stack gap={0}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <RailNode first last={steps.length === 0} selected={selected === null} label={<Icon name="Settings2" size={13} color={selected === null ? theme.colors.accentForeground : theme.colors.foregroundMuted} />}>
          {null}
        </RailNode>
        <Pressable accessibilityRole="button" accessibilityLabel="Workflow settings" onPress={() => onSelect(null)} style={row(selected === null)}>
          <Txt size="sm" weight="600">
            Workflow settings
          </Txt>
          <Txt size="xs" tone="muted" numberOfLines={1}>
            {`${workflow.mode === "dynamic" ? "dynamic" : "fixed"} · ${workflow.context ?? "handoff"} · ${workflowModel}`}
          </Txt>
        </Pressable>
      </View>
      {steps.map((step, index) => {
        const problems = stepProblems(step, "step");
        const active = selected === index;
        const approvals = step.tasks.some((task) => task.confirm);
        const loops = step.tasks.some((task) => task.until !== undefined || (task.repeat ?? 1) > 1);
        const waits = step.tasks.some((task) => task.delay !== undefined || task.every !== undefined);
        return (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <RailNode first={false} last={index === steps.length - 1} selected={active} label={<Txt size="xs" weight="700" style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground }}>{index + 1}</Txt>}>
              {null}
            </RailNode>
            <Stack gap={0} style={{ flex: 1 }}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Step ${index + 1} ${step.name}`} onPress={() => onSelect(index)} style={row(active)}>
                <Row gap={6}>
                  <Txt size="sm" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
                    {step.name || "(unnamed)"}
                  </Txt>
                  {approvals ? <Icon name="Hand" size={12} color={theme.colors.statusWarning} /> : null}
                  {loops ? <Icon name="Repeat" size={12} color={theme.colors.foregroundMuted} /> : null}
                  {waits ? <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} /> : null}
                </Row>
                <Txt size="xs" tone={problems.length ? "danger" : "muted"} numberOfLines={1}>
                  {problems.length
                    ? `${problems.length} problem${problems.length === 1 ? "" : "s"}`
                    : `${shortModel(step.agent?.model, "inherits model")} · ${step.tasks.length} task${step.tasks.length === 1 ? "" : "s"}`}
                </Txt>
              </Pressable>
              {active ? (
                <Row gap={0} style={{ paddingLeft: 4, marginTop: -2, marginBottom: 4 }}>
                  <IconButton icon="ArrowUp" label={`Move step ${index + 1} up`} disabled={index === 0} onPress={() => onChange(move(steps, index, index - 1), index - 1)} />
                  <IconButton icon="ArrowDown" label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onPress={() => onChange(move(steps, index, index + 1), index + 1)} />
                  <IconButton
                    icon="Copy"
                    label={`Duplicate step ${index + 1}`}
                    onPress={() => {
                      const next = insertCopy(steps, index);
                      next[index + 1] = { ...next[index + 1], name: uniqueStepName(steps, slug(step.name) || "step") };
                      onChange(next, index + 1);
                    }}
                  />
                  <IconButton
                    icon="Trash2"
                    label={`Delete step ${index + 1}`}
                    tone="danger"
                    onPress={() => {
                      const next = steps.filter((_, i) => i !== index);
                      onChange(next, next.length === 0 ? null : Math.min(index, next.length - 1));
                    }}
                  />
                </Row>
              ) : null}
            </Stack>
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add step"
        onPress={() => onChange([...steps, { name: uniqueStepName(steps, "step"), tasks: [{ prompt: "" }] }], steps.length)}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
          marginTop: 8,
          marginLeft: 36,
          height: 34,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: theme.colors.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          backgroundColor: hovered ? theme.colors.surface2 : "transparent",
        })}
      >
        <Icon name="Plus" size={14} color={theme.colors.foregroundMuted} />
        <Txt size="sm" tone="muted" weight="500">
          Add step
        </Txt>
      </Pressable>
      {steps.length === 0 ? (
        <Txt size="xs" tone="muted" style={{ paddingTop: 8, paddingLeft: 36 }}>
          {workflow.mode === "dynamic" ? "A dynamic workflow may start without steps; the planner writes them." : "A fixed workflow needs at least one step."}
        </Txt>
      ) : null}
    </Stack>
  );
}

function Validation({ workflow }: { workflow: Workflow }) {
  const { theme } = useUi();
  const problems = useMemo(() => workflowProblems(workflow), [workflow]);
  const inputs = useMemo(() => workflowInputs(workflow), [workflow]);
  const asks = useMemo(() => askModels(workflow), [workflow]);
  return (
    <Stack gap={10}>
      {problems.length ? (
        <Notice tone="danger" title={`${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before saving`}>
          <Stack gap={2}>
            {problems.map((problem, index) => (
              <Txt key={index} size="sm" tone="muted">
                {`• ${problem}`}
              </Txt>
            ))}
          </Stack>
        </Notice>
      ) : null}
      <Row gap={6} wrap>
        {problems.length ? null : (
          <Row gap={5}>
            <Icon name="CircleCheck" size={14} color={theme.colors.statusSuccess} />
            <Txt size="sm" tone="success" weight="500">
              Valid
            </Txt>
          </Row>
        )}
        {inputs.length ? (
          <Row gap={6} wrap style={{ marginLeft: problems.length ? 0 : 8 }}>
            <Txt size="sm" tone="muted">
              Inputs
            </Txt>
            {inputs.map((input) => (
              <Badge key={input} label={`{{${input}}}`} tone="accent" />
            ))}
          </Row>
        ) : null}
        {asks.map((ask) => (
          <Badge key={ask.target} icon="MessageCircleQuestion" label={ask.target === -1 ? "asks for the default model" : `asks for a model: step ${ask.target + 1}`} tone="warning" />
        ))}
      </Row>
    </Stack>
  );
}

function NameInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { theme, compact } = useUi();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      accessibilityLabel="Workflow name"
      value={value}
      onChangeText={onChange}
      placeholder="workflow-name"
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        flex: 1,
        minWidth: 120,
        color: theme.colors.foreground,
        fontSize: compact ? 18 : 22,
        fontWeight: "600",
        letterSpacing: -0.3,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: focused ? theme.colors.accent : "transparent",
        backgroundColor: focused ? theme.colors.surface0 : "transparent",
      }}
    />
  );
}

function DraftCard({
  open,
  onToggle,
  description,
  onDescription,
  busy,
  onDraft,
  problems,
}: {
  open: boolean;
  onToggle: () => void;
  description: string;
  onDescription: (text: string) => void;
  busy: boolean;
  onDraft: () => void;
  problems: string[];
}) {
  const { theme } = useUi();
  return (
    <View style={{ borderWidth: 1, borderColor: open ? tint(theme.colors.accent, 0.5) : theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Draft with AI"
        onPress={onToggle}
        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 12,
          backgroundColor: hovered ? theme.colors.surface2 : "transparent",
        })}
      >
        <View style={{ width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: tint(theme.colors.accent, 0.35) }}>
          <Icon name="Sparkles" size={15} color={theme.colors.foreground} />
        </View>
        <Stack gap={0} style={{ flex: 1 }}>
          <Txt size="sm" weight="600">
            Draft with AI
          </Txt>
          <Txt size="xs" tone="muted" numberOfLines={1}>
            {`Describe it; ${DEFAULT_MODEL} writes the workflow and you review it here before saving.`}
          </Txt>
        </Stack>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          <Field
            value={description}
            onChangeText={onDescription}
            placeholder="The steps, who does each, models, approvals, and waits. For example: implement a change, check it against current docs, open a PR, wait for CI, and merge after my approval."
            multiline
            minHeight={80}
          />
          <Row gap={8} justify="flex-end">
            <Button label={busy ? "Drafting…" : "Draft workflow"} icon="Sparkles" variant="primary" busy={busy} disabled={!description.trim()} onPress={onDraft} />
          </Row>
          {problems.length ? <Notice tone="warning" title="The draft has problems to fix">{problems.join("; ")}</Notice> : null}
        </View>
      ) : null}
    </View>
  );
}

// The editor --------------------------------------------------------------------------------

export function WorkflowEditor({
  cwd,
  target,
  onClose,
  onSaved,
  onRun,
}: {
  cwd?: string;
  target: EditorTarget;
  onClose: () => void;
  onSaved?: (saved: Saved) => void;
  onRun?: (saved: Saved) => void;
}) {
  const { theme, compact } = useUi();
  const toast = useToast();
  const start = useMemo(() => startingWorkflow(target), [target]);
  const [workflow, setWorkflow] = useState<Workflow>(start.workflow);
  const [scope, setScope] = useState<ScopeName>(target.scope === "project" && !cwd ? "global" : target.scope);
  const [origin, setOrigin] = useState<{ name: string; scope: ScopeName } | null>(target.kind === "edit" ? { name: target.name, scope: target.scope } : null);
  const [loaded, setLoaded] = useState(target.kind === "new");
  const [dirty, setDirty] = useState(target.kind === "new" && Boolean(target.draft));
  const [selected, setSelected] = useState<number | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [draftOpen, setDraftOpen] = useState(target.kind === "new" && !target.draft);
  const [draftProblems, setDraftProblems] = useState<string[]>([]);
  const [pendingDraft, setPendingDraft] = useState<{ workflow: Workflow; problems: string[] } | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<"save" | "run" | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const existing = useRpcQuery(
    workflowGetRpc,
    { name: target.kind === "edit" ? target.name : "", cwd, source: target.scope },
    { enabled: target.kind === "edit" },
  );
  useEffect(() => {
    if (loaded || !existing.data) return;
    const parsed = parseWorkflow(existing.data.workflow);
    if (parsed.ok) setWorkflow(parsed.workflow);
    else {
      setJsonMode(true);
      setJsonText(JSON.stringify(existing.data.workflow, null, 2));
      setJsonError(parsed.error);
    }
    setScope(existing.data.source);
    setOrigin({ name: target.kind === "edit" ? target.name : String(existing.data.workflow.name ?? ""), scope: existing.data.source });
    setLoaded(true);
    setDirty(false);
  }, [existing.data, loaded, target]);

  const catalog = useRpcQuery(catalogRpc, { cwd }, { staleTime: 60_000 });
  const modelList = useRpcQuery(modelsRpc, {}, { staleTime: 300_000 });
  const options: Options = useMemo(() => {
    const models = new Set<string>([DEFAULT_MODEL, ...(catalog.data?.models ?? [])]);
    for (const model of modelList.data?.models ?? []) models.add(`${model.provider}/${model.id}`);
    return {
      skills: catalog.data?.skills ?? [],
      mcpServers: catalog.data?.mcpServers ?? [],
      subagents: catalog.data?.subagents ?? ["explore", "build", "advisor"],
      tools: catalog.data?.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
      models: [...models],
    };
  }, [catalog.data, modelList.data]);

  const save = useRpcMutation(workflowSaveRpc, { invalidates: ["wf.list", "wf.get"], toastErrors: false });
  const draft = useRpcMutation(workflowDraftRpc);

  const replace = (next: Workflow) => {
    setWorkflow(next);
    if (jsonMode) {
      setJsonText(prettyWorkflow(next));
      setJsonError(null);
    }
  };
  const change = (next: Workflow) => {
    setWorkflow(next);
    setDirty(true);
  };

  const problems = useMemo(() => workflowProblems(workflow), [workflow]);
  const selectedStep = selected !== null && selected < workflow.steps.length ? selected : null;

  async function doSave(after: "save" | "run", overwrite = false) {
    if (jsonMode && jsonError) {
      toast.error("Fix the JSON before you save.");
      return;
    }
    try {
      const result = await save.mutateAsync({
        workflow: normalizeWorkflow(workflow) as Record<string, unknown>,
        scope,
        cwd,
        previous: origin ?? undefined,
        overwrite,
      });
      setOrigin({ name: result.name, scope: result.source });
      setWorkflow((current) => ({ ...current, name: result.name }));
      setDirty(false);
      toast.show(`Saved ${result.name}`, { variant: "success" });
      const saved = { name: result.name, source: result.source };
      onSaved?.(saved);
      if (after === "run") onRun?.(saved);
    } catch (error) {
      const message = errorMessage(error);
      if (/exists already/.test(message) && !overwrite) setPendingOverwrite(after);
      else toast.error(message);
    }
  }

  function applyDraft(next: Workflow, nextProblems: string[]) {
    replace(next);
    setSelected(null);
    setDirty(true);
    setDraftProblems(nextProblems);
  }

  function requestDraft() {
    const text = description.trim();
    if (!text) return;
    draft.mutate(
      { description: text, cwd },
      {
        onSuccess: (result) => {
          const parsed = parseWorkflow(result.workflow);
          if (!parsed.ok) {
            toast.error(`The draft is not a valid workflow: ${parsed.error}`);
            return;
          }
          if (dirty || target.kind === "edit") setPendingDraft({ workflow: parsed.workflow, problems: result.problems });
          else applyDraft(parsed.workflow, result.problems);
        },
      },
    );
  }

  function toggleJson(next: boolean) {
    if (next === jsonMode) return;
    if (next) {
      setJsonText(prettyWorkflow(workflow));
      setJsonError(null);
      setJsonMode(true);
      return;
    }
    if (jsonError) {
      toast.error("Fix the JSON before you switch to the form.");
      return;
    }
    setJsonMode(false);
  }

  if (target.kind === "edit" && !loaded) {
    if (existing.error) {
      return (
        <Stack gap={12}>
          <ErrorBox title={`Cannot open ${target.name}`} error={existing.error} />
          <Row>
            <Button label="Back" icon="ArrowLeft" onPress={onClose} />
          </Row>
        </Stack>
      );
    }
    return <Spinner label={`Opening ${target.name}…`} />;
  }

  const canSave = problems.length === 0 && !(jsonMode && jsonError);
  const close = () => (dirty ? setConfirmClose(true) : onClose());
  const fileName = slug(workflow.name);

  return (
    <Stack gap={18}>
      <Stack gap={10}>
        <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 10 }}>
          <Row gap={6} style={{ flex: 1 }}>
            <IconButton icon="ArrowLeft" label="Close the editor" onPress={close} />
            <NameInput value={workflow.name} onChange={(name) => change({ ...workflow, name })} />
          </Row>
          <Row gap={8} justify={compact ? "space-between" : "flex-end"} wrap>
            <View style={{ justifyContent: "center" }}>
              {dirty ? <Badge label="unsaved" tone="warning" /> : origin ? <Badge label="saved" tone="success" icon="Check" /> : <Badge label="new" />}
            </View>
            <Chips
              options={[
                { label: "Form", value: "form" },
                { label: "JSON", value: "json" },
              ]}
              value={jsonMode ? "json" : "form"}
              onChange={(next: "form" | "json") => toggleJson(next === "json")}
            />
            <Row gap={8}>
              <Button label="Save" icon="Save" variant={onRun ? "secondary" : "primary"} busy={save.isPending} disabled={!canSave} onPress={() => void doSave("save")} />
              {onRun ? <Button label="Save and run" icon="Play" variant="primary" disabled={!canSave || save.isPending} onPress={() => void doSave("run")} /> : null}
            </Row>
          </Row>
        </View>
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            alignItems: compact ? "flex-start" : "center",
            gap: compact ? 8 : 12,
            paddingHorizontal: compact ? 0 : 6,
          }}
        >
          <Row gap={8}>
            <Txt size="sm" tone="muted">
              Save to
            </Txt>
            <Chips
              options={cwd ? [{ label: "Global", value: "global" as ScopeName }, { label: "This project", value: "project" as ScopeName }] : [{ label: "Global", value: "global" as ScopeName }]}
              value={scope}
              onChange={(next: ScopeName) => {
                setScope(next);
                setDirty(true);
              }}
            />
          </Row>
          <Row gap={6} style={{ flexShrink: 1, alignSelf: compact ? "stretch" : "auto" }}>
            {scope === "project" && cwd ? (
              <>
                <WorkspaceChip dir={cwd} open={false} />
                <Txt size="xs" tone="muted" mono numberOfLines={1} style={{ flexShrink: 1 }}>
                  {`.pi/ext/workflows/definitions/${fileName || "…"}.json`}
                </Txt>
              </>
            ) : (
              <Row gap={6} style={{ flexShrink: 1 }}>
                <Icon name="Globe" size={13} color={theme.colors.foregroundMuted} />
                <Txt size="xs" tone="muted" mono numberOfLines={1} style={{ flexShrink: 1 }}>
                  {`~/.pi/agent/ext/workflows/definitions/${fileName || "…"}.json`}
                </Txt>
              </Row>
            )}
          </Row>
        </View>
        {!cwd ? (
          <Txt size="xs" tone="muted" style={{ paddingHorizontal: compact ? 0 : 6 }}>
            Open the editor from a workspace to save project workflows.
          </Txt>
        ) : null}
      </Stack>

      {scope === "project" && cwd ? <WorkspaceNotices cwd={cwd} what="project workflows" /> : null}
      {start.error ? <Notice tone="danger">{start.error}</Notice> : null}
      {catalog.data?.error ? <Notice tone="warning" title="pi's catalog is not available">{`Skills, MCP servers, and models are not listed (${catalog.data.error}). You can still type names.`}</Notice> : null}

      <DraftCard
        open={draftOpen}
        onToggle={() => setDraftOpen(!draftOpen)}
        description={description}
        onDescription={setDescription}
        busy={draft.isPending}
        onDraft={requestDraft}
        problems={draftProblems}
      />

      <Validation workflow={workflow} />

      {jsonMode ? (
        <Card style={{ gap: 10 }}>
          <Row justify="space-between">
            <Row gap={8}>
              <Icon name="Braces" size={15} color={theme.colors.foregroundMuted} />
              <Txt size="sm" weight="600">
                Definition
              </Txt>
            </Row>
            <Txt size="xs" tone="muted">
              Unknown fields are errors, as in pi.
            </Txt>
          </Row>
          <Field
            value={jsonText}
            onChangeText={(text) => {
              setJsonText(text);
              setDirty(true);
              const parsed = parseWorkflowText(text);
              if (parsed.ok) {
                setWorkflow(parsed.workflow);
                setJsonError(null);
              } else setJsonError(parsed.error);
            }}
            multiline
            mono
            minHeight={460}
            error={jsonError}
          />
        </Card>
      ) : (
        <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 14 : 20, alignItems: "flex-start" }}>
          <View style={compact ? { alignSelf: "stretch" } : { width: 290 }}>
            <Txt size="xs" weight="600" tone="muted" style={{ paddingLeft: 4, paddingBottom: 6 }}>
              {`PIPELINE · ${workflow.steps.length} STEP${workflow.steps.length === 1 ? "" : "S"}`}
            </Txt>
            <StepRail
              workflow={workflow}
              selected={selectedStep}
              onSelect={setSelected}
              onChange={(steps, select) => {
                change({ ...workflow, steps });
                if (select !== undefined) setSelected(select);
              }}
            />
          </View>
          <View style={{ flex: compact ? undefined : 1, alignSelf: "stretch", minWidth: 0 }}>
            {selectedStep === null ? (
              <WorkflowSettings workflow={workflow} options={options} onChange={change} />
            ) : (
              <StepDetail
                key={selectedStep}
                step={workflow.steps[selectedStep]}
                index={selectedStep}
                options={options}
                onChange={(step) => change({ ...workflow, steps: workflow.steps.map((other, i) => (i === selectedStep ? step : other)) })}
              />
            )}
          </View>
        </View>
      )}

      <Txt size="xs" tone="muted">
        Saving validates the workflow as pi does and writes it in pi's format. Running pi sessions pick up the change the next time they list workflows.
      </Txt>

      <ConfirmModal
        open={confirmClose}
        title="Discard changes?"
        body="The workflow has unsaved changes."
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onClose={() => setConfirmClose(false)}
      />
      <ConfirmModal
        open={pendingDraft !== null}
        title="Replace the form with the draft?"
        body="The draft replaces the workflow in the editor. Nothing is saved until you press Save."
        confirmLabel="Replace"
        onConfirm={() => {
          if (pendingDraft) applyDraft(pendingDraft.workflow, pendingDraft.problems);
          setPendingDraft(null);
        }}
        onClose={() => setPendingDraft(null)}
      />
      <ConfirmModal
        open={pendingOverwrite !== null}
        title={`Overwrite ${fileName}?`}
        body={`A ${scope} workflow named ${fileName} exists already. Saving replaces it.`}
        confirmLabel="Overwrite"
        danger
        busy={save.isPending}
        onConfirm={() => {
          const after = pendingOverwrite ?? "save";
          setPendingOverwrite(null);
          void doSave(after, true);
        }}
        onClose={() => setPendingOverwrite(null)}
      />
    </Stack>
  );
}
