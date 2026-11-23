// pi itself: version and path, updates, default model, health, limits, usage, and settings files.
import type { RpcOutput } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import {
  authCheckRpc,
  defaultsWriteRpc,
  doctorRpc,
  extensionsListRpc,
  modelsRpc,
  overviewRpc,
  settingsReadRpc,
  settingsWriteRpc,
  statsRpc,
  updateRpc,
  usageRpc,
  workflowsListRpc,
  type AuthCheck,
  type AuthTarget,
  type ScopeName,
} from "../shared/contracts";
import { statsRowName, type StatsRow } from "../shared/stats";
import { DEFAULT_MODEL, DEFAULT_THINKING, THINKING_LEVELS } from "../shared/workflow";
import type { ManagerTab } from "./host";
import { useRpcMutation, useRpcQuery } from "./queries";
import {
  Badge,
  Button,
  Card,
  Chips,
  CodeBlock,
  ConfirmModal,
  ErrorBox,
  Field,
  Notice,
  ProgressBar,
  Row,
  Section,
  Spinner,
  StatTile,
  StatusDot,
  Stack,
  Txt,
  shortPath,
  tint,
  useUi,
  type Tone,
} from "./ui";
import { WorkspaceNotices } from "./workspaces";

type Overview = RpcOutput<typeof overviewRpc>;

export function OverviewTab({ cwd, onNavigate }: { cwd: string; onNavigate: (tab: ManagerTab) => void }) {
  const { compact } = useUi();
  const overview = useRpcQuery(overviewRpc, { cwd: cwd || undefined }, { refetchInterval: 10_000 });
  return (
    <Stack gap={20}>
      {cwd ? <WorkspaceNotices cwd={cwd} /> : null}
      {overview.error ? <ErrorBox error={overview.error} /> : null}
      {overview.data?.pi.error ? <ErrorBox title="pi" error={overview.data.pi.error} /> : null}
      {overview.data && !overview.data.workflows.installed ? (
        <Notice tone="warning" title="Workflows are not installed">
          {overview.data.workflows.error ?? "Install marketplace:workflows on the Extensions tab."}
        </Notice>
      ) : null}
      <Tiles cwd={cwd} overview={overview.data} onNavigate={onNavigate} />
      <View style={{ flexDirection: compact ? "column" : "row", gap: 16, alignItems: "flex-start" }}>
        <Stack gap={16} style={{ flex: 1, alignSelf: "stretch" }}>
          {overview.data ? <Defaults defaults={overview.data.defaults} /> : <Spinner />}
          <Maintenance overview={overview.data} />
        </Stack>
        <Stack gap={16} style={{ flex: 1, alignSelf: "stretch" }}>
          <Health cwd={cwd} />
          <Limits />
        </Stack>
      </View>
      <Stats cwd={cwd} />
      <SettingsFile cwd={cwd} />
    </Stack>
  );
}

function Tiles({ cwd, overview, onNavigate }: { cwd: string; overview: Overview | undefined; onNavigate: (tab: ManagerTab) => void }) {
  const extensions = useRpcQuery(extensionsListRpc, { scope: "global" }, { staleTime: 30_000 });
  const workflows = useRpcQuery(workflowsListRpc, { cwd: cwd || undefined }, { staleTime: 15_000 });
  const ext = extensions.data?.extensions ?? [];
  const enabled = ext.filter((e) => e.enabled).length;
  const flows = workflows.data?.workflows ?? [];
  const project = flows.filter((w) => w.source === "project").length;
  const runs = overview?.runs;
  return (
    <Row gap={12} wrap align="stretch">
      <StatTile icon="Terminal" label="pi" value={overview?.pi.version ? `v${overview.pi.version}` : "…"} hint={overview?.pi.path ? shortPath(overview.pi.path) : undefined} />
      <StatTile
        icon="Puzzle"
        label="Extensions"
        value={extensions.data ? `${enabled} on` : "…"}
        hint={extensions.data ? `${ext.length} installed · ${extensions.data.packages.filter((p) => p.scope === "global").length} packages` : undefined}
        onPress={() => onNavigate("extensions")}
      />
      <StatTile
        icon="Workflow"
        label="Workflows"
        value={workflows.data ? String(flows.length) : "…"}
        hint={workflows.data ? (cwd ? `${project} in this workspace · ${flows.length - project} global` : `${flows.length} global`) : undefined}
        onPress={() => onNavigate("workflows")}
      />
      <StatTile
        icon={runs?.approvals ? "Hand" : "Activity"}
        label="Runs"
        tone={runs?.approvals ? "warning" : runs?.active ? "accent" : "default"}
        value={runs ? (runs.active ? `${runs.active} active` : "Idle") : "…"}
        hint={runs?.approvals ? `${runs.approvals} waiting for approval` : "No approvals waiting"}
        onPress={() => onNavigate("runs")}
      />
    </Row>
  );
}

function CardTitle({ icon, title, right }: { icon: string; title: string; right?: ReactNode }) {
  const { theme } = useUi();
  return (
    <Row justify="space-between" gap={8}>
      <Row gap={8} style={{ flexShrink: 1 }}>
        <View style={{ flexShrink: 0 }}>
          <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
        </View>
        <Txt weight="600" style={{ flexShrink: 1 }}>
          {title}
        </Txt>
      </Row>
      {right}
    </Row>
  );
}

function Defaults({ defaults }: { defaults: Overview["defaults"] }) {
  const { theme } = useUi();
  const models = useRpcQuery(modelsRpc, {}, { staleTime: 300_000 });
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState(defaults.provider ?? "");
  const [model, setModel] = useState(defaults.model ?? "");
  const [thinking, setThinking] = useState(defaults.thinking ?? "");
  const [filter, setFilter] = useState("");
  const reset = () => {
    setProvider(defaults.provider ?? "");
    setModel(defaults.model ?? "");
    setThinking(defaults.thinking ?? "");
    setFilter("");
  };
  useEffect(reset, [defaults.provider, defaults.model, defaults.thinking]);
  const target: AuthTarget | null = defaults.model || defaults.provider ? { provider: defaults.provider, model: defaults.model } : null;
  const check = useRpcQuery(authCheckRpc, { targets: target ? [target] : [] }, { enabled: target !== null, staleTime: 60_000 });
  const save = useRpcMutation(defaultsWriteRpc, {
    invalidates: ["pi.overview", "pi.auth.check"],
    success: "Saved the default model to settings.json",
    onSuccess: () => setEditing(false),
  });
  const dirty = provider !== (defaults.provider ?? "") || model !== (defaults.model ?? "") || thinking !== (defaults.thinking ?? "");
  const matches = useMemo(() => {
    const words = filter.trim().toLowerCase();
    if (!words) return [];
    return (models.data?.models ?? []).filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(words)).slice(0, 8);
  }, [filter, models.data]);
  const [recommendedProvider, recommendedModel] = DEFAULT_MODEL.split("/");
  const current = defaults.model ? `${defaults.provider ? `${defaults.provider}/` : ""}${defaults.model}` : "pi's built-in default";
  return (
    <Card>
      <CardTitle icon="Sparkles" title="Default model" right={editing ? null : <Button small variant="outline" label="Change" onPress={() => setEditing(true)} />} />
      <Row gap={8} wrap>
        <Txt mono size="md" weight="500">
          {current}
        </Txt>
        {defaults.thinking ? <Badge label={`thinking ${defaults.thinking}`} /> : null}
      </Row>
      {check.data?.results[0] ? <AuthLine check={check.data.results[0]} forModel /> : check.isFetching ? <Spinner label="Checking the sign-in" /> : null}
      {check.error ? <ErrorBox error={check.error} /> : null}
      <Txt size="xs" tone="muted">
        New pi sessions and workflow steps without a model of their own use it.
      </Txt>
      {editing ? (
        <Stack gap={12} style={{ marginTop: 6 }}>
          <View style={{ alignSelf: "flex-start" }}>
            <Button
              small
              variant="secondary"
              icon="Wand"
              label={`Use ${recommendedModel} · ${DEFAULT_THINKING}`}
              onPress={() => {
                setProvider(recommendedProvider);
                setModel(recommendedModel);
                setThinking(DEFAULT_THINKING);
              }}
            />
          </View>
          <Row gap={8} wrap align="flex-start">
            <View style={{ flexGrow: 1, flexBasis: 140 }}>
              <Field label="Provider" value={provider} onChangeText={setProvider} placeholder={recommendedProvider} mono />
            </View>
            <View style={{ flexGrow: 2, flexBasis: 200 }}>
              <Field label="Model" value={model} onChangeText={setModel} placeholder={recommendedModel} mono />
            </View>
          </Row>
          <Chips label="Thinking" options={[{ label: "unset", value: "" }, ...THINKING_LEVELS.map((level) => ({ label: level, value: level }))]} value={thinking} onChange={setThinking} />
          <Field label="Search models" value={filter} onChangeText={setFilter} placeholder={`${models.data?.models.length ?? ""} models available`} />
          {models.data?.error ? <Notice>{models.data.error}</Notice> : null}
          {matches.length > 0 ? (
            <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
              {matches.map((m, index) => (
                <Row key={`${m.provider}/${m.id}`} justify="space-between" style={{ paddingHorizontal: 10, paddingVertical: 4, borderTopWidth: index ? 1 : 0, borderColor: theme.colors.border }}>
                  <Txt size="sm" mono numberOfLines={1} style={{ flex: 1 }}>
                    {`${m.provider}/${m.id}`}
                  </Txt>
                  <Txt size="xs" tone="muted">
                    {m.context}
                  </Txt>
                  <Button
                    small
                    variant="ghost"
                    label="Use"
                    onPress={() => {
                      setProvider(m.provider);
                      setModel(m.id);
                      setFilter("");
                    }}
                  />
                </Row>
              ))}
            </View>
          ) : null}
          <Row justify="flex-end">
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                reset();
                setEditing(false);
              }}
            />
            <Button label="Save" variant="primary" disabled={!dirty} busy={save.isPending} onPress={() => save.mutate({ provider, model, thinking })} />
          </Row>
        </Stack>
      ) : null}
    </Card>
  );
}

function ActionRow({ icon, title, detail, action, last }: { icon: string; title: string; detail: string; action: ReactNode; last?: boolean }) {
  const { theme } = useUi();
  return (
    <Row gap={12} style={{ paddingVertical: 10, borderBottomWidth: last ? 0 : 1, borderColor: theme.colors.border }}>
      <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface2 }}>
        <Icon name={icon} size={15} color={theme.colors.foreground} />
      </View>
      <Stack gap={0} style={{ flex: 1 }}>
        <Txt size="sm" weight="600">
          {title}
        </Txt>
        <Txt size="xs" tone="muted">
          {detail}
        </Txt>
      </Stack>
      {action}
    </Row>
  );
}

function Maintenance({ overview }: { overview: Overview | undefined }) {
  const update = useRpcMutation(updateRpc, {
    invalidates: ["pi.overview", "ext.list", "ext.search", "pi.models", "wf.catalog"],
    success: (result) => (result.ok ? "Update finished" : null),
  });
  const [confirm, setConfirm] = useState<null | "self" | "all">(null);
  const run = (target: "self" | "extensions" | "models" | "all") => update.mutate({ target });
  const busy = (target: string) => update.isPending && update.variables?.target === target;
  return (
    <Card>
      <CardTitle icon="Wrench" title="Maintenance" />
      <Stack gap={0}>
        <ActionRow
          icon="Download"
          title="pi"
          detail={overview?.pi.version ? `v${overview.pi.version} · running sessions keep their version until they restart` : "Update the pi binary"}
          action={<Button small label="Update" busy={busy("self")} disabled={update.isPending} onPress={() => setConfirm("self")} />}
        />
        <ActionRow icon="Puzzle" title="Extensions" detail="Update every installed package" action={<Button small label="Update" busy={busy("extensions")} disabled={update.isPending} onPress={() => run("extensions")} />} />
        <ActionRow icon="RefreshCw" title="Model catalogs" detail="Refresh the providers' model lists" action={<Button small label="Refresh" busy={busy("models")} disabled={update.isPending} onPress={() => run("models")} />} />
        <ActionRow icon="PackageCheck" title="Everything" detail="pi and all extensions" last action={<Button small label="Update all" busy={busy("all")} disabled={update.isPending} onPress={() => setConfirm("all")} />} />
      </Stack>
      {update.data ? (
        <Stack gap={6}>
          <Badge label={update.data.ok ? "finished" : `failed${update.data.code !== null ? ` (exit ${update.data.code})` : ""}`} tone={update.data.ok ? "success" : "danger"} />
          {update.data.output ? <CodeBlock text={update.data.output} maxHeight={220} /> : null}
        </Stack>
      ) : null}
      <ConfirmModal
        open={confirm !== null}
        title={confirm === "all" ? "Update pi and all extensions" : "Update pi"}
        body="This replaces the pi binary on the daemon machine with the latest release. Workflow runs that are running keep the binary they started with."
        confirmLabel="Update"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) run(confirm);
          setConfirm(null);
        }}
      />
    </Card>
  );
}

interface DoctorReport {
  ok?: boolean;
  target?: string;
  install?: { method?: string };
  path?: { shadowed?: boolean };
  config?: { files?: { name: string; path: string; exists: boolean; errors: string[] }[] };
  auth?: { providers?: { provider: string; authType: string }[] };
  mcp?: { servers?: { name: string; enabled: boolean; transport: string }[] };
  problems?: unknown[];
  warnings?: unknown[];
}

/** A short status and, when the check is not ready, what to do next. */
function authStatus(check: AuthCheck, forModel: boolean): { tone: Tone; label: string; next: string | null } {
  const login = `Run /login ${check.provider} in pi to sign in or save an API key.`;
  if (check.status === "ready") {
    return { tone: "success", label: `Ready · ${check.authType === "oauth" ? "signed in to" : "API key set for"} ${check.provider}`, next: null };
  }
  if (check.status === "failed") return { tone: "danger", label: `Could not check ${check.provider}`, next: check.error };
  if (check.status === "invalid") {
    return {
      tone: "danger",
      label: `Could not check ${check.provider}`,
      next: forModel
        ? "pi cannot match this model to one provider, or models.json does not load. Choose the model again with Change."
        : "models.json does not load, so pi cannot check providers. Fix the error that Health lists for it.",
    };
  }
  const reasons: Record<string, { label: string; next: string }> = {
    provider_not_found: {
      label: `pi does not know ${check.provider}`,
      next: "Check the provider name, the disabledProviders list in settings.json, and models.json.",
    },
    credentials_not_configured: { label: `Not signed in to ${check.provider}`, next: login },
    credential_not_available: { label: `No usable credential for ${check.provider}`, next: login },
  };
  const known = check.reason ? reasons[check.reason] : undefined;
  return { tone: "danger", label: known?.label ?? `Not ready${check.reason ? ` (${check.reason})` : ""}`, next: known?.next ?? login };
}

function AuthLine({ check, forModel }: { check: AuthCheck; forModel?: boolean }) {
  const status = authStatus(check, Boolean(forModel));
  return (
    <Stack gap={2}>
      <Row gap={6}>
        <StatusDot tone={status.tone} />
        <Txt size="sm" weight={status.next ? "600" : undefined} tone={status.next ? "danger" : undefined}>
          {status.label}
        </Txt>
      </Row>
      {status.next ? (
        <Txt size="xs" tone="muted" style={{ paddingLeft: 14 }}>
          {status.next}
        </Txt>
      ) : null}
    </Stack>
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Label({ children }: { children: string }) {
  return (
    <Txt size="xs" tone="muted" weight="600" style={{ letterSpacing: 0.4 }}>
      {children.toUpperCase()}
    </Txt>
  );
}

function Health({ cwd }: { cwd: string }) {
  const doctor = useRpcQuery(doctorRpc, { cwd: cwd || undefined }, { staleTime: 60_000 });
  const report = doctor.data?.report as DoctorReport | null | undefined;
  const problems = report?.problems ?? [];
  const warnings = report?.warnings ?? [];
  const servers = report?.mcp?.servers ?? [];
  const files = (report?.config?.files ?? []).filter((file) => file.exists);
  const fileErrors = files.flatMap((file) => file.errors.map((error) => `${file.name}: ${error}`));
  const providers = report?.auth?.providers ?? [];
  const checks = useRpcQuery(
    authCheckRpc,
    { targets: providers.map((provider) => ({ provider: provider.provider, model: null })) },
    { enabled: providers.length > 0, staleTime: 60_000 },
  );
  const results = checks.data?.results ?? [];
  const notReady = results.filter((check) => check.status !== "ready");
  const items = [
    ...problems.map((p) => ({ tone: "danger" as const, text: asText(p) })),
    ...warnings.map((w) => ({ tone: "warning" as const, text: asText(w) })),
    ...fileErrors.map((text) => ({ tone: "danger" as const, text })),
  ];
  return (
    <Card>
      <CardTitle icon="Stethoscope" title="Health" right={<Button
            small
            variant="ghost"
            icon="RefreshCw"
            label="Check"
            busy={doctor.isFetching || checks.isFetching}
            onPress={() => {
              void doctor.refetch();
              void checks.refetch();
            }}
          />
        }
      />
      {doctor.isLoading ? <Spinner label="Running pi doctor" /> : null}
      {doctor.data?.error ? <ErrorBox error={doctor.data.error} /> : null}
      {report ? (
        <Stack gap={12}>
          <Row gap={6}>
            <StatusDot tone={report.ok ? "success" : "danger"} />
            <Txt size="sm" weight="600">
              {report.ok ? "Healthy" : `${problems.length || "Some"} problem${problems.length === 1 ? "" : "s"}`}
            </Txt>
            <Txt size="xs" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
              {[report.target, report.install?.method ? `installed by ${report.install.method}` : null].filter(Boolean).join(" · ")}
            </Txt>
          </Row>
          {items.map((item, index) => (
            <Txt key={index} size="sm" tone={item.tone}>
              {`• ${item.text}`}
            </Txt>
          ))}
          {report.path?.shadowed ? <Notice>Another pi binary comes first on PATH.</Notice> : null}
          <Stack gap={6}>
            <Label>{checks.data ? `Providers · ${results.length - notReady.length} of ${results.length} ready` : "Providers"}</Label>
            {providers.length === 0 ? (
              <Txt size="sm" tone="muted">
                No provider is signed in. Run /login in pi to sign in or save an API key.
              </Txt>
            ) : null}
            <Row gap={6} wrap>
              {providers.map((provider, index) => {
                const check = results[index];
                if (check && check.status !== "ready") return null;
                return (
                  <Badge
                    key={provider.provider}
                    label={provider.provider}
                    tone={check ? "success" : "muted"}
                    icon={provider.authType === "oauth" ? "BadgeCheck" : "KeyRound"}
                  />
                );
              })}
            </Row>
            {notReady.map((check) => (
              <AuthLine key={check.provider} check={check} />
            ))}
            {checks.error ? <ErrorBox error={checks.error} /> : null}
          </Stack>
          <Stack gap={6}>
            <Label>{`MCP servers · ${servers.filter((s) => s.enabled).length} of ${servers.length} on`}</Label>
            <Row gap={6} wrap>
              {servers.map((server) => (
                <Badge key={server.name} label={server.name} tone={server.enabled ? "success" : "muted"} icon={server.enabled ? "Plug" : "Unplug"} />
              ))}
            </Row>
          </Stack>
        </Stack>
      ) : null}
    </Card>
  );
}

interface UsageWindow {
  label?: string;
  usedPercent?: number;
  resetsAt?: string | null;
  /** `model` when the window limits only the model `families`. */
  scope?: string;
  families?: string[];
}

interface ProviderUsage {
  provider: string;
  plan?: string | null;
  windows?: UsageWindow[];
  error?: string | null;
  /** Why the read failed, such as `login`, `rateLimited`, or `unsupported`. */
  errorKind?: string;
  fetchedAt?: number;
  retryAfterMs?: number;
  credits?: { available: boolean; unlimited: boolean; balance?: string };
}

function creditsText(credits: ProviderUsage["credits"]): string | null {
  if (!credits) return null;
  if (credits.unlimited) return "Unlimited credits";
  if (!credits.available) return "No credits";
  return credits.balance ? `${credits.balance} credits` : "Credits available";
}

function windowLabel(limit: UsageWindow, index: number): string {
  const label = limit.label ?? `limit ${index + 1}`;
  if (limit.scope !== "model") return label;
  return `${label} · ${limit.families?.length ? `${limit.families.join(", ")} only` : "some models only"}`;
}

function UsageError({ usage }: { usage: ProviderUsage }) {
  const tone: Tone = usage.errorKind === "unsupported" ? "muted" : usage.errorKind === "rateLimited" ? "warning" : "danger";
  const retryAt = usage.retryAfterMs && usage.fetchedAt ? new Date(usage.fetchedAt + usage.retryAfterMs) : null;
  const error = retryAt ? (usage.error ?? "").replace(/\s*Try again later\.?$/, "") : usage.error;
  return (
    <Txt size="xs" tone={tone}>
      {`${error}${retryAt ? ` Try again after ${retryAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : ""}`}
    </Txt>
  );
}

function Limits() {
  const [enabled, setEnabled] = useState(false);
  const usage = useRpcQuery(usageRpc, {}, { enabled, staleTime: 60_000 });
  const report = usage.data?.report as { providers?: ProviderUsage[] } | null | undefined;
  return (
    <Card>
      <CardTitle
        icon="Gauge"
        title="Subscription limits"
        right={<Button small variant={enabled ? "ghost" : "outline"} icon={enabled ? "RefreshCw" : undefined} label={enabled ? "Refresh" : "Check"} busy={usage.isFetching} onPress={() => (enabled ? void usage.refetch() : setEnabled(true))} />}
      />
      {!enabled ? (
        <Txt size="sm" tone="muted">
          Asks each provider pi is signed in to for its 5-hour, weekly, and billing-cycle limits.
        </Txt>
      ) : usage.isLoading ? (
        <Spinner label="Asking the providers" />
      ) : usage.data?.error ? (
        <ErrorBox error={usage.data.error} />
      ) : report?.providers?.length === 0 ? (
        <Txt size="sm" tone="muted">
          No sign-in reports limits. Run /login in pi for anthropic, openai-codex, cursor, xai, or google-antigravity.
        </Txt>
      ) : report?.providers ? (
        <Stack gap={14}>
          {report.providers.map((provider) => {
            const credits = creditsText(provider.credits);
            return (
              <Stack key={provider.provider} gap={6}>
                <Row justify="space-between" gap={8} wrap>
                  <Row gap={6} style={{ flexShrink: 1 }}>
                    <Txt size="sm" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {provider.provider}
                    </Txt>
                    {provider.plan ? <Badge label={provider.plan} /> : null}
                  </Row>
                  {credits ? (
                    <Txt size="xs" tone="muted" style={{ flexShrink: 0 }}>
                      {credits}
                    </Txt>
                  ) : null}
                </Row>
                {provider.error ? <UsageError usage={provider} /> : null}
                {!provider.error && !provider.windows?.length ? (
                  <Txt size="xs" tone="muted">
                    No limits reported.
                  </Txt>
                ) : null}
                {(provider.windows ?? []).map((limit, index) => {
                  const percent = limit.usedPercent ?? 0;
                  return (
                    <Stack key={index} gap={3}>
                      <Row justify="space-between" gap={10} wrap>
                        <Txt size="xs" numberOfLines={1} style={{ flexGrow: 1, flexShrink: 1 }}>
                          {windowLabel(limit, index)}
                        </Txt>
                        <Txt size="xs" tone={percent > 85 ? "danger" : "muted"} style={{ flexShrink: 0 }}>
                          {`${Math.round(percent)}%${limit.resetsAt ? ` · resets ${new Date(limit.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric" })}` : ""}`}
                        </Txt>
                      </Row>
                      <ProgressBar value={percent / 100} tone={percent > 85 ? "danger" : percent > 65 ? "warning" : "success"} />
                    </Stack>
                  );
                })}
              </Stack>
            );
          })}
        </Stack>
      ) : (
        <CodeBlock text={JSON.stringify(usage.data?.report, null, 2)} />
      )}
    </Card>
  );
}

interface StatsDay {
  /** `YYYY-MM-DD`, a local day of the daemon machine. */
  date: string;
  sessions?: number;
  cost?: number;
  tokens?: { total?: number };
}

interface StatsReport {
  /** ISO start of the counted period, with `since`. */
  since?: string | null;
  sessions?: number;
  prompts?: number;
  assistantTurns?: number;
  cost?: number;
  tokens?: { total?: number };
  byModel?: StatsRow[];
  byProvider?: StatsRow[];
  byDay?: StatsDay[];
}

const STATS_PERIODS = [
  { label: "All time", value: "all" },
  { label: "30 days", value: "30d" },
  { label: "7 days", value: "7d" },
  { label: "24 hours", value: "24h" },
] as const;
type StatsPeriod = (typeof STATS_PERIODS)[number]["value"];

function compactNumber(value: number | undefined): string {
  if (value === undefined) return "0";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function Stats({ cwd }: { cwd: string }) {
  const { theme, compact } = useUi();
  const [all, setAll] = useState(!cwd);
  const [period, setPeriod] = useState<StatsPeriod>("all");
  const since = period === "all" ? undefined : period;
  const stats = useRpcQuery(statsRpc, { cwd: cwd || undefined, all: all || !cwd, since }, { staleTime: 60_000 });
  const report = stats.data?.report as StatsReport | null | undefined;
  const where = all || !cwd ? "Every pi session on this machine" : "pi sessions in this workspace";
  const periodLabel = STATS_PERIODS.find((option) => option.value === period)?.label.toLowerCase();
  return (
    <Section
      title="Usage"
      description={since ? `${where}, last ${periodLabel}` : where}
      right={
        <Row gap={16} wrap style={{ flexShrink: 1 }}>
          {cwd ? (
            <Chips
              options={[
                { label: "This workspace", value: "project" },
                { label: "Everywhere", value: "all" },
              ]}
              value={all ? "all" : "project"}
              onChange={(value) => setAll(value === "all")}
            />
          ) : null}
          <Chips options={STATS_PERIODS} value={period} onChange={setPeriod} />
        </Row>
      }
    >
      {stats.isLoading ? <Spinner /> : null}
      {stats.data?.error ? <ErrorBox error={stats.data.error} /> : null}
      {report ? (
        <Card>
          <Row gap={28} wrap>
            <Figure label="Sessions" value={compactNumber(report.sessions)} />
            <Figure label="Prompts" value={compactNumber(report.prompts)} />
            <Figure label="Turns" value={compactNumber(report.assistantTurns)} />
            <Figure label="Tokens" value={compactNumber(report.tokens?.total)} />
            <Figure label="Cost" value={`$${(report.cost ?? 0).toFixed(2)}`} />
          </Row>
          <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 6 }} />
          {report.sessions ? (
            <Stack gap={20}>
              <View style={{ flexDirection: compact ? "column" : "row", gap: compact ? 20 : 32 }}>
                <Breakdown title="By model" rows={report.byModel ?? []} />
                <Breakdown title="By provider" rows={report.byProvider ?? []} />
              </View>
              <Days days={report.byDay ?? []} since={report.since ?? null} />
            </Stack>
          ) : (
            <Txt size="sm" tone="muted">
              {since ? "No pi sessions in this period. Choose a longer period." : "No pi sessions yet."}
            </Txt>
          )}
        </Card>
      ) : null}
    </Section>
  );
}

/** The six most expensive rows, with bars relative to the first. */
function Breakdown({ title, rows }: { title: string; rows: StatsRow[] }) {
  const { theme } = useUi();
  const top = rows.slice(0, 6);
  const maxCost = Math.max(0.01, ...top.map((row) => row.cost ?? 0));
  return (
    <Stack gap={10} style={{ flex: 1, minWidth: 0 }}>
      <Label>{title}</Label>
      {top.map((row, index) => (
        <Stack key={index} gap={3}>
          <Row justify="space-between" gap={12}>
            <Txt size="sm" mono numberOfLines={1} style={{ flex: 1 }}>
              {statsRowName(row)}
            </Txt>
            <Txt size="sm" weight="600" style={{ flexShrink: 0 }}>
              {`$${(row.cost ?? 0).toFixed(2)}`}
            </Txt>
          </Row>
          <Txt size="xs" tone="muted">
            {`${row.sessions ? `${row.sessions} session${row.sessions === 1 ? "" : "s"} · ` : ""}${compactNumber(row.tokens?.total)} tokens`}
          </Txt>
          <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.surface2 }}>
            <View style={{ height: 3, borderRadius: 2, width: `${Math.round(((row.cost ?? 0) / maxCost) * 100)}%`, backgroundColor: tint(theme.colors.accent, 0.9) }} />
          </View>
        </Stack>
      ))}
    </Stack>
  );
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** pi counts days over the last 14; a shorter period starts the row at its first day. */
function lastDays(since: string | null): string[] {
  const now = new Date();
  const start = since ? new Date(since).getTime() : -Infinity;
  const keys: string[] = [];
  for (let back = 13; back >= 0; back--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back + 1);
    if (next.getTime() > start) keys.push(dateKey(day));
  }
  return keys;
}

const DAY_BAR_HEIGHT = 64;

function Days({ days, since }: { days: StatsDay[]; since: string | null }) {
  const { theme } = useUi();
  const byDate = new Map(days.map((day) => [day.date, day]));
  const keys = lastDays(since);
  const byCost = days.some((day) => (day.cost ?? 0) > 0);
  const amount = (day: StatsDay | undefined) => (byCost ? day?.cost : day?.tokens?.total) ?? 0;
  const format = (day: StatsDay) => `${byCost ? `$${(day.cost ?? 0).toFixed(2)} · ` : ""}${compactNumber(day.tokens?.total)} tokens`;
  const max = Math.max(0, ...keys.map((key) => amount(byDate.get(key))));
  const busiest = days.reduce<StatsDay | undefined>((best, day) => (amount(day) > amount(best) ? day : best), undefined);
  const short = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <Stack gap={6}>
      <Label>{`Last ${keys.length} day${keys.length === 1 ? "" : "s"}${byCost ? " · cost" : " · tokens"}`}</Label>
      <Row gap={3} align="flex-end" style={{ height: DAY_BAR_HEIGHT }}>
        {keys.map((key) => {
          const day = byDate.get(key);
          const value = amount(day);
          return (
            <View
              key={key}
              accessibilityLabel={day ? `${short(key)}: ${format(day)}` : `${short(key)}: no sessions`}
              style={{
                flex: 1,
                height: value > 0 && max > 0 ? Math.max(3, Math.round((value / max) * DAY_BAR_HEIGHT)) : 2,
                borderRadius: 2,
                backgroundColor: value > 0 ? tint(theme.colors.accent, 0.9) : theme.colors.surface2,
              }}
            />
          );
        })}
      </Row>
      <Row justify="space-between" gap={8}>
        <Txt size="xs" tone="muted">
          {short(keys[0])}
        </Txt>
        <Txt size="xs" tone="muted">
          Today
        </Txt>
      </Row>
      <Txt size="xs" tone="muted">
        {busiest ? `Busiest day: ${short(busiest.date)} · ${format(busiest)}` : "No sessions on these days."}
      </Txt>
    </Stack>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Txt size="xs" tone="muted">
        {label}
      </Txt>
      <Txt size="xl" weight="600">
        {value}
      </Txt>
    </Stack>
  );
}

function SettingsFile({ cwd }: { cwd: string }) {
  const [scope, setScope] = useState<ScopeName>("global");
  const [open, setOpen] = useState(false);
  const read = useRpcQuery(settingsReadRpc, { scope, cwd: cwd || undefined }, { enabled: open && (scope === "global" || Boolean(cwd)) });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (read.data) setText(read.data.text);
  }, [read.data]);
  const write = useRpcMutation(settingsWriteRpc, { invalidates: ["pi.settings.read", "pi.overview", "pi.models"], success: "Saved settings.json" });
  const validate = (value: string) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      setError(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : "settings.json must be a JSON object");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  return (
    <Card>
      <CardTitle icon="FileCog" title="settings.json" right={<Button small variant="outline" label={open ? "Close" : "Edit"} onPress={() => setOpen(!open)} />} />
      <Txt size="sm" tone="muted">
        pi's global or workspace settings. pi reads them when a session starts or on /reload.
      </Txt>
      {open ? (
        <Stack gap={10}>
          <Chips
            options={[
              { label: "Global", value: "global" as const },
              { label: "This workspace", value: "project" as const },
            ]}
            value={scope}
            onChange={setScope}
          />
          {scope === "project" && !cwd ? (
            <Notice tone="muted">Choose a workspace at the top to edit its .pi/settings.json.</Notice>
          ) : read.isLoading ? (
            <Spinner />
          ) : read.data ? (
            <Stack gap={8}>
              <Txt size="xs" tone="muted" mono>
                {`${read.data.path}${read.data.exists ? "" : " (new file)"}`}
              </Txt>
              <Field
                value={text}
                onChangeText={(value) => {
                  setText(value);
                  validate(value);
                }}
                multiline
                mono
                minHeight={320}
                error={error}
              />
              <Row justify="flex-end">
                <Button label="Revert" variant="ghost" disabled={text === read.data.text} onPress={() => setText(read.data?.text ?? "")} />
                <Button label="Save" variant="primary" disabled={Boolean(error) || text === read.data.text} busy={write.isPending} onPress={() => write.mutate({ scope, cwd: cwd || undefined, text })} />
              </Row>
            </Stack>
          ) : read.error ? (
            <ErrorBox error={read.error} />
          ) : null}
        </Stack>
      ) : null}
    </Card>
  );
}
