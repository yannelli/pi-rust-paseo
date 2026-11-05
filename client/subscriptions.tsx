// The Subscriptions tab: Claude and Codex subscription accounts of the subscription-router
// extension. Accounts with their usage, adding and removing them, each provider's account policy
// (how requests pick an account, fallbacks, Codex usage resets), and router profiles.
import { openExternalUrl } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { modelsRpc } from "../shared/contracts";
import {
  ACCOUNT_STRATEGIES,
  RESET_HELP,
  RESET_USES,
  STRATEGY_HELP,
  THINKING_LEVELS,
  parseAccountProvider,
  routerPolicySaveRpc,
  routerProfilesSaveRpc,
  routerRunRpc,
  routerStateRpc,
  type Entry,
  type Policy,
  type Profile,
  type SubscriptionAccount,
  type SubscriptionBase,
  type UsageWindow,
} from "../shared/router";
import { ExtensionGate } from "./gate";
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
  ProgressBar,
  Row,
  Section,
  Spinner,
  Stack,
  Toggle,
  Txt,
  UiModal,
  relativeTime,
  shortPath,
  useUi,
  type Tone,
} from "./ui";

type State = NonNullable<ReturnType<typeof useRouterState>["data"]>;
type ProviderState = State["providers"][number];

const INVALIDATES = ["router.state"] as const;
const APPLIES = "New pi sessions use it; running ones after /reload.";

function useRouterState() {
  return useRpcQuery(routerStateRpc, {}, { staleTime: 10_000, refetchInterval: 30_000 });
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  "5h": "5-hour",
  primary: "5-hour",
  seven_day: "weekly",
  "7d": "weekly",
  secondary: "weekly",
};

function windowLabel(window: UsageWindow): string {
  const known = WINDOW_LABELS[window.name];
  if (known) return known;
  if (window.durationMs && window.durationMs <= 6 * 3_600_000) return "5-hour";
  if (window.families?.length) return `weekly ${window.families.join(", ")}`;
  return window.name.replace(/_/g, " ");
}

function windowTone(used: number): Tone {
  return used >= 100 ? "danger" : used >= 80 ? "warning" : "success";
}

export function SubscriptionsTab() {
  const state = useRouterState();
  const refresh = useRpcMutation(routerRunRpc, { invalidates: INVALIDATES, success: (result) => (result.ok ? "Usage refreshed." : null) });
  const data = state.data;
  return (
    <Stack gap={24}>
      <ExtensionGate name="subscription-router">The subscription router keeps several Claude and Codex accounts behind one provider and picks one for each request.</ExtensionGate>
      <Row gap={10} justify="space-between" wrap>
        <Txt size="sm" tone="muted" style={{ flex: 1, minWidth: 240 }}>
          Several Claude and Codex subscriptions behind one provider: each model shows once, and a policy picks the account for each request, moves on when one is full, and falls back to another provider when all are.
        </Txt>
        <Row gap={8}>
          <IconButton icon="RefreshCw" label="Reload" onPress={() => void state.refetch()} />
          <Button small variant="outline" icon="Gauge" label="Read usage now" busy={refresh.isPending} onPress={() => refresh.mutate({ action: "refresh" })} />
        </Row>
      </Row>
      {refresh.data && !refresh.data.ok ? <ErrorBox title="Reading usage failed" error={refresh.data.output} /> : null}
      {state.error ? <ErrorBox error={state.error} /> : null}
      {state.isLoading ? <Spinner label="Reading the router" /> : null}
      {data ? (
        <>
          {!data.accountsMode ? (
            <Notice title={`pi ${data.piVersion ?? ""} lists each account's models separately`}>
              This pi has no before_provider_auth yet, so the router adds anthropic-2/… copies of the models and switches models to change accounts. Update pi to keep each model once; the policies below apply either way.
            </Notice>
          ) : null}
          {data.configError ? <ErrorBox title="The router config cannot be read" error={data.configError} /> : null}
          {data.providers.map((provider) => (
            <ProviderSection key={provider.base} provider={provider} providers={data.providers} />
          ))}
          <Profiles state={data} />
          <Txt size="xs" tone="muted" mono>
            {shortPath(data.configPath)}
          </Txt>
        </>
      ) : null}
    </Stack>
  );
}

function ProviderSection({ provider, providers }: { provider: ProviderState; providers: ProviderState[] }) {
  const { compact } = useUi();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SubscriptionAccount | null>(null);
  const remove = useRpcMutation(routerRunRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? "Account removed." : null),
    onSuccess: () => setRemoving(null),
  });
  return (
    <Section
      title={`${provider.label} · ${provider.accounts.length} account${provider.accounts.length === 1 ? "" : "s"}`}
      description={`Account 1 is pi's own ${provider.base} login; more accounts log in here or with /router add.`}
      right={<Button small variant="primary" icon="UserPlus" label="Add account" onPress={() => setAdding(true)} />}
    >
      <View style={{ flexDirection: compact ? "column" : "row", gap: 12, flexWrap: "wrap" }}>
        {provider.accounts.map((account) => (
          <View key={account.provider} style={{ width: compact ? "100%" : "32%", minWidth: compact ? undefined : 260, flexGrow: 1 }}>
            <AccountCard account={account} base={provider.base} onRemove={() => setRemoving(account)} />
          </View>
        ))}
      </View>
      {remove.data && !remove.data.ok ? <ErrorBox error={remove.data.output} /> : null}
      <PolicyEditor provider={provider} providers={providers} />
      {provider.base === "openai-codex" ? <Resets accounts={provider.accounts} /> : null}
      <AddAccount open={adding} base={provider.base} label={provider.label} onClose={() => setAdding(false)} />
      <ConfirmModal
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""}?`}
        body={`The router stops using ${removing?.provider ?? ""} and forgets its token. A login pi stored stays until /logout ${removing?.provider ?? ""}.`}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate({ action: "remove", provider: removing.provider })}
        onClose={() => setRemoving(null)}
      />
    </Section>
  );
}

function AccountCard({ account, base, onRemove }: { account: SubscriptionAccount; base: SubscriptionBase; onRemove: () => void }) {
  const usage = account.usage;
  const now = Date.now();
  const windows = (usage?.windows ?? []).filter((window) => window.resetAt === null || window.resetAt > now);
  const full = windows.find((window) => window.usedPercent >= 100);
  const login =
    account.login === "missing" ? <Badge label="no login" tone="danger" icon="CircleAlert" /> : account.login === "router" ? <Badge label="router token" /> : <Badge label={account.slot === 1 ? "pi login" : "logged in"} tone="success" />;
  return (
    <Card style={{ gap: 10 }}>
      <Row gap={8} justify="space-between">
        <Row gap={6} wrap style={{ flex: 1 }}>
          <Txt size="md" weight="600">
            {account.name}
          </Txt>
          {login}
          {usage?.tier ? <Badge label={usage.tier} /> : null}
          {full ? <Badge label={`full · ${duration((full.resetAt ?? now) - now)}`} tone="danger" /> : null}
        </Row>
        {account.slot > 1 ? <IconButton icon="Trash2" label={`Remove ${account.name}`} onPress={onRemove} /> : null}
      </Row>
      <Txt size="xs" tone="muted" mono>
        {account.provider === base ? `${base} (pi login)` : account.provider}
      </Txt>
      {usage === null ? (
        <Txt size="xs" tone="muted">
          No usage read yet.
        </Txt>
      ) : usage.unlimited ? (
        <Txt size="xs" tone="muted">
          Unlimited.
        </Txt>
      ) : windows.length === 0 ? (
        <Txt size="xs" tone="muted">
          {usage.message ?? "No usage windows."}
        </Txt>
      ) : (
        <Stack gap={8}>
          {windows.map((window) => (
            <Stack key={window.name} gap={3}>
              <Row justify="space-between">
                <Txt size="xs" weight="500">
                  {windowLabel(window)}
                </Txt>
                <Txt size="xs" tone="muted">
                  {`${Math.round(window.usedPercent)}% used${window.resetAt ? ` · resets in ${duration(window.resetAt - now)}` : ""}`}
                </Txt>
              </Row>
              <ProgressBar value={window.usedPercent / 100} tone={windowTone(window.usedPercent)} height={5} />
            </Stack>
          ))}
        </Stack>
      )}
      {usage ? (
        <Txt size="xs" tone="muted">
          {usage.status === "available" ? `Read ${relativeTime(usage.retrievedAt)}` : `${usage.status}${usage.message ? `: ${usage.message}` : ""}`}
        </Txt>
      ) : null}
    </Card>
  );
}

function PolicyEditor({ provider, providers }: { provider: ProviderState; providers: ProviderState[] }) {
  const [draft, setDraft] = useState<Policy>(provider.policy);
  const [picking, setPicking] = useState(false);
  useEffect(() => setDraft(provider.policy), [provider.policy]);
  const save = useRpcMutation(routerPolicySaveRpc, { invalidates: INVALIDATES, success: () => `Saved the ${provider.label} policy. ${APPLIES}` });
  const changed = JSON.stringify(draft) !== JSON.stringify(provider.policy);
  const set = (patch: Partial<Policy>) => setDraft({ ...draft, ...patch });
  const move = (index: number, by: number) => {
    const next = [...draft.fallback];
    const [entry] = next.splice(index, 1);
    next.splice(index + by, 0, entry);
    set({ fallback: next });
  };
  return (
    <Card style={{ gap: 14 }}>
      <Row justify="space-between" wrap gap={8}>
        <Txt size="sm" weight="600">
          {`How ${provider.short} requests pick an account`}
        </Txt>
        {changed ? <Badge label="unsaved" tone="warning" /> : null}
      </Row>
      <Chips options={ACCOUNT_STRATEGIES.map((value) => ({ label: value, value }))} value={draft.strategy} onChange={(strategy) => set({ strategy })} />
      <Txt size="xs" tone="muted">
        {STRATEGY_HELP[draft.strategy]}
      </Txt>
      {draft.strategy === "manual" ? (
        <Chips label="Account" options={provider.accounts.map((a) => ({ label: a.name, value: String(a.slot) }))} value={String(draft.account)} onChange={(value) => set({ account: Number(value) })} />
      ) : null}
      {draft.strategy === "threshold" ? (
        <Field label="Switch at (percent used)" value={String(draft.switchAt)} onChangeText={(value) => set({ switchAt: Math.min(100, Math.max(1, Number(value.replace(/[^0-9.]/g, "")) || 0)) })} hint="An account counts as full at this percent of its 5-hour or weekly window." />
      ) : null}
      <Stack gap={8}>
        <Row justify="space-between" wrap gap={8}>
          <Stack gap={0} style={{ flex: 1, minWidth: 200 }}>
            <Txt size="sm" weight="500">
              When every account is full
            </Txt>
            <Txt size="xs" tone="muted">
              {draft.fallback.length ? "Use these models of other providers, in order." : "Stop with an error until an account frees up."}
            </Txt>
          </Stack>
          <Button small variant="outline" icon="Plus" label="Add fallback" onPress={() => setPicking(true)} />
        </Row>
        {draft.fallback.map((entry, index) => (
          <EntryRow
            key={`${entry.model}#${entry.account ?? 1}`}
            entry={entry}
            providers={providers}
            onChange={(next) => set({ fallback: draft.fallback.map((e, i) => (i === index ? next : e)) })}
            onRemove={() => set({ fallback: draft.fallback.filter((_, i) => i !== index) })}
            onUp={index > 0 ? () => move(index, -1) : undefined}
            onDown={index < draft.fallback.length - 1 ? () => move(index, 1) : undefined}
          />
        ))}
        {draft.fallback.length ? <Toggle label="Switch back when an account has room" value={draft.returnWhenAvailable} onChange={(returnWhenAvailable) => set({ returnWhenAvailable })} /> : null}
      </Stack>
      {provider.base === "openai-codex" ? (
        <Stack gap={8}>
          <Chips label="Banked usage resets" options={RESET_USES.map((value) => ({ label: value, value }))} value={draft.useResets} onChange={(useResets) => set({ useResets })} />
          <Txt size="xs" tone="muted">
            {RESET_HELP[draft.useResets]}
          </Txt>
          {draft.useResets !== "off" ? (
            <Field
              label="Skip a reset when the window frees up within (minutes)"
              value={String(draft.resetMinWaitMinutes)}
              onChangeText={(value) => set({ resetMinWaitMinutes: Math.max(0, Number(value.replace(/[^0-9.]/g, "")) || 0) })}
            />
          ) : null}
        </Stack>
      ) : null}
      {save.error ? <ErrorBox error={save.error} /> : null}
      <Row justify="flex-end" gap={8}>
        <Button label="Revert" variant="ghost" disabled={!changed} onPress={() => setDraft(provider.policy)} />
        <Button label="Save policy" variant="primary" disabled={!changed} busy={save.isPending} onPress={() => save.mutate({ provider: provider.base, policy: draft })} />
      </Row>
      <ModelPicker
        open={picking}
        title="Fall back to"
        exclude={provider.base}
        providers={providers}
        onPick={(entry) => {
          set({ fallback: [...draft.fallback, entry] });
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </Card>
  );
}

/** One model of a fallback list or a profile chain: account and thinking level. */
function EntryRow({
  entry,
  providers,
  onChange,
  onRemove,
  onUp,
  onDown,
}: {
  entry: Entry;
  providers: ProviderState[];
  onChange: (entry: Entry) => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { theme } = useUi();
  const base = parseAccountProvider(entry.model.split("/")[0])?.base;
  const accounts = providers.find((p) => p.base === base)?.accounts ?? [];
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, gap: 8 }}>
      <Row justify="space-between" gap={8}>
        <Txt size="sm" mono weight="600" numberOfLines={1} style={{ flex: 1 }}>
          {entry.model}
        </Txt>
        <Row gap={2}>
          {onUp ? <IconButton icon="ArrowUp" label="Move up" onPress={onUp} /> : null}
          {onDown ? <IconButton icon="ArrowDown" label="Move down" onPress={onDown} /> : null}
          <IconButton icon="X" label={`Remove ${entry.model}`} onPress={onRemove} />
        </Row>
      </Row>
      {accounts.length > 1 ? (
        <Chips
          options={[{ label: "policy", value: "0" }, ...accounts.map((a) => ({ label: a.name, value: String(a.slot) }))]}
          value={String(entry.account ?? 0)}
          onChange={(value) => onChange({ ...entry, account: Number(value) > 1 ? Number(value) : undefined })}
        />
      ) : null}
      <Chips
        options={[{ label: "thinking: as is", value: "" }, ...THINKING_LEVELS.map((level) => ({ label: level, value: level }))]}
        value={entry.thinking ?? ""}
        onChange={(value) => onChange({ ...entry, thinking: value ? (value as Entry["thinking"]) : undefined })}
      />
    </View>
  );
}

function ModelPicker({
  open,
  title,
  exclude,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  exclude?: SubscriptionBase;
  providers: ProviderState[];
  onPick: (entry: Entry) => void;
  onClose: () => void;
}) {
  const { theme } = useUi();
  const models = useRpcQuery(modelsRpc, {}, { staleTime: 300_000, enabled: open });
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (models.data?.models ?? [])
      .filter((model) => model.provider !== "router")
      .filter((model) => {
        const parsed = parseAccountProvider(model.provider);
        return !(parsed && (parsed.slot > 1 || parsed.base === exclude));
      })
      .map((model) => `${model.provider}/${model.id}`)
      .filter((key) => words.every((word) => key.toLowerCase().includes(word)))
      .slice(0, 40);
  }, [models.data, query, exclude]);
  return (
    <UiModal title={title} open={open} onClose={onClose}>
      <Field value={query} onChangeText={setQuery} placeholder="Search models" autoFocus />
      {models.isLoading ? <Spinner /> : null}
      {models.data?.error ? <ErrorBox error={models.data.error} /> : null}
      <Stack gap={0}>
        {shown.map((key, index) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            onPress={() => onPick({ model: key })}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => ({
              paddingVertical: 9,
              paddingHorizontal: 10,
              borderTopWidth: index ? 1 : 0,
              borderColor: theme.colors.border,
              backgroundColor: hovered ? theme.colors.surface2 : "transparent",
            })}
          >
            <Txt size="sm" mono>
              {key}
            </Txt>
          </Pressable>
        ))}
      </Stack>
      {models.data && shown.length === 0 ? <Empty icon="SearchX" title="No models match" /> : null}
    </UiModal>
  );
}

function AddAccount({ open, base, label, onClose }: { open: boolean; base: SubscriptionBase; label: string; onClose: () => void }) {
  const [started, setStarted] = useState<{ id: string; name: string; url: string; paste: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const start = useRpcMutation(routerRunRpc, {
    onSuccess: (result) => {
      const data = result.data as { id?: string; name?: string; url?: string; paste?: string } | null;
      if (result.ok && data?.id && data.url) setStarted({ id: data.id, name: data.name ?? label, url: data.url, paste: data.paste ?? "the code" });
    },
  });
  const finish = useRpcMutation(routerRunRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? `Added ${(result.data as { name?: string } | null)?.name ?? "the account"}. ${APPLIES}` : null),
    onSuccess: (result) => {
      if (result.ok) close();
    },
  });
  const close = () => {
    setStarted(null);
    setPasted("");
    start.reset();
    finish.reset();
    onClose();
  };
  return (
    <UiModal title={`Add a ${label} account`} open={open} onClose={close}>
      {!started ? (
        <>
          <Txt size="sm">{`Sign in with the ${label} subscription you want to add. The router keeps the token on the daemon machine and refreshes it.`}</Txt>
          {start.data && !start.data.ok ? <ErrorBox error={start.data.output} /> : null}
          {start.error ? <ErrorBox error={start.error} /> : null}
          <Row justify="flex-end">
            <Button label="Cancel" variant="ghost" onPress={close} />
            <Button label="Start sign-in" variant="primary" icon="LogIn" busy={start.isPending} onPress={() => start.mutate({ action: "login-start", provider: base })} />
          </Row>
        </>
      ) : (
        <>
          <Txt size="sm">{`1. Open the sign-in page and sign in to the account for ${started.name}.`}</Txt>
          <Row gap={8} wrap>
            <Button small variant="primary" icon="ExternalLink" label="Open sign-in page" onPress={() => void openExternalUrl(started.url)} />
          </Row>
          <CodeBlock text={started.url} maxHeight={80} />
          <Txt size="sm">{`2. Paste ${started.paste}.`}</Txt>
          <Field value={pasted} onChangeText={setPasted} placeholder={base === "anthropic" ? "code#state" : "http://localhost:1455/auth/callback?code=…"} mono />
          {finish.data && !finish.data.ok ? <ErrorBox error={finish.data.output} /> : null}
          {finish.error ? <ErrorBox error={finish.error} /> : null}
          <Row justify="flex-end">
            <Button label="Cancel" variant="ghost" onPress={close} />
            <Button label="Add account" variant="primary" disabled={!pasted.trim()} busy={finish.isPending} onPress={() => finish.mutate({ action: "login-finish", id: started.id, pasted: pasted.trim() })} />
          </Row>
        </>
      )}
    </UiModal>
  );
}

type ResetList = { accounts: { provider: string; available: number; error?: string; credits?: { title?: string | null; type?: string; status?: string; expiresAt?: string | null }[] }[] };

function Resets({ accounts }: { accounts: SubscriptionAccount[] }) {
  const list = useRpcMutation(routerRunRpc, {});
  const [using, setUsing] = useState<number | null>(null);
  const use = useRpcMutation(routerRunRpc, {
    invalidates: INVALIDATES,
    success: (result) => {
      const data = result.data as { reset?: boolean } | null;
      return result.ok && data?.reset ? "Used a usage reset." : null;
    },
    onSuccess: () => {
      setUsing(null);
      list.mutate({ action: "resets-list" });
    },
  });
  const data = (list.data?.ok ? list.data.data : null) as ResetList | null;
  const notApplied = use.data?.ok && !(use.data.data as { reset?: boolean } | null)?.reset;
  return (
    <Card style={{ gap: 10 }}>
      <Row justify="space-between" gap={8} wrap>
        <Stack gap={0} style={{ flex: 1, minWidth: 200 }}>
          <Txt size="sm" weight="600">
            Banked usage resets
          </Txt>
          <Txt size="xs" tone="muted">
            Some Codex plans bank resets that refresh the 5-hour and weekly windows. The policy above can spend them; you can also spend one here.
          </Txt>
        </Stack>
        <Button small variant="outline" icon="RotateCcw" label="Check resets" busy={list.isPending} onPress={() => list.mutate({ action: "resets-list" })} />
      </Row>
      {list.data && !list.data.ok ? <ErrorBox error={list.data.output} /> : null}
      {notApplied ? <Notice tone="muted">No reset was applied: none is banked, or there was nothing to reset.</Notice> : null}
      {data?.accounts.map((entry) => {
        const account = accounts.find((a) => a.provider === entry.provider);
        return (
          <Row key={entry.provider} gap={8} justify="space-between" wrap>
            <Stack gap={0} style={{ flex: 1, minWidth: 180 }}>
              <Txt size="sm" weight="500">
                {`${account?.name ?? entry.provider}: ${entry.error ? "unknown" : `${entry.available} banked`}`}
              </Txt>
              {entry.error ? (
                <Txt size="xs" tone="warning">
                  {entry.error}
                </Txt>
              ) : null}
              {(entry.credits ?? [])
                .filter((credit) => credit.status !== "redeemed")
                .map((credit, index) => (
                  <Txt key={index} size="xs" tone="muted">
                    {`${credit.title ?? credit.type ?? "reset"}${credit.expiresAt ? ` · expires ${new Date(credit.expiresAt).toLocaleDateString()}` : ""}`}
                  </Txt>
                ))}
            </Stack>
            {entry.available > 0 && account ? <Button small variant="outline" label="Use one" onPress={() => setUsing(account.slot)} /> : null}
          </Row>
        );
      })}
      <ConfirmModal
        open={using !== null}
        title="Use a usage reset?"
        body={`This spends one banked reset on Codex #${using ?? ""}: its 5-hour and weekly windows start over.`}
        confirmLabel="Use reset"
        busy={use.isPending}
        onConfirm={() => using && use.mutate({ action: "resets-use", account: using })}
        onClose={() => setUsing(null)}
      />
    </Card>
  );
}

function Profiles({ state }: { state: State }) {
  const [editing, setEditing] = useState<{ profile: Profile; isNew: boolean } | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const save = useRpcMutation(routerProfilesSaveRpc, {
    invalidates: INVALIDATES,
    success: () => `Saved router profiles. ${APPLIES}`,
    onSuccess: () => {
      setEditing(null);
      setDeleting(null);
    },
  });
  const saveAll = (profiles: Profile[], autoSwitchOn429?: boolean) => save.mutate({ profiles, autoSwitchOn429 });
  return (
    <Section
      title={`Router models · ${state.profiles.length}`}
      description="router/<name> models pick a model from a chain by quota, and move down the chain when one is exhausted."
      right={
        <Button
          small
          variant="outline"
          icon="Plus"
          label="New router model"
          onPress={() => setEditing({ profile: { id: "", name: "", strategy: "balanced", chain: [], exhaustionPolicy: null, maxWaitMinutes: null }, isNew: true })}
        />
      }
    >
      {state.profiles.length === 0 ? (
        <Card>
          <Empty icon="Route" title="No router models" body="A router model such as router/main tries Claude Opus, then Codex, then Sonnet, by quota." />
        </Card>
      ) : null}
      {state.profiles.map((profile) => (
        <Card key={profile.id} style={{ gap: 6 }} onPress={() => setEditing({ profile, isNew: false })} accessibilityLabel={`Edit router/${profile.id}`}>
          <Row justify="space-between" gap={8}>
            <Row gap={6} wrap style={{ flex: 1 }}>
              <Txt size="sm" weight="600" mono>{`router/${profile.id}`}</Txt>
              <Badge label={profile.strategy} />
              {profile.exhaustionPolicy ? <Badge label={profile.exhaustionPolicy === "wait" ? `waits${profile.maxWaitMinutes ? ` ${profile.maxWaitMinutes}m` : ""}` : "fails when exhausted"} /> : null}
            </Row>
            <IconButton icon="Trash2" label={`Delete router/${profile.id}`} onPress={() => setDeleting(profile)} />
          </Row>
          <Txt size="xs" tone="muted" numberOfLines={2}>
            {profile.chain.map((e) => `${e.model}${e.account ? ` #${e.account}` : ""}${e.thinking ? ` (${e.thinking})` : ""}`).join("  ›  ")}
          </Txt>
        </Card>
      ))}
      <Toggle label="Switch accounts on rate limits (autoSwitchOn429)" value={state.autoSwitchOn429} onChange={(value) => saveAll(state.profiles, value)} />
      {save.error ? <ErrorBox error={save.error} /> : null}
      {editing ? (
        <ProfileEditor
          key={editing.profile.id || "new"}
          initial={editing.profile}
          isNew={editing.isNew}
          state={state}
          busy={save.isPending}
          onSave={(profile) => saveAll(editing.isNew ? [...state.profiles, profile] : state.profiles.map((p) => (p.id === editing.profile.id ? profile : p)))}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmModal
        open={deleting !== null}
        title={`Delete router/${deleting?.id ?? ""}?`}
        body="Sessions on this router model need another model."
        confirmLabel="Delete"
        danger
        busy={save.isPending}
        onConfirm={() => deleting && saveAll(state.profiles.filter((p) => p.id !== deleting.id))}
        onClose={() => setDeleting(null)}
      />
    </Section>
  );
}

function ProfileEditor({
  initial,
  isNew,
  state,
  busy,
  onSave,
  onClose,
}: {
  initial: Profile;
  isNew: boolean;
  state: State;
  busy: boolean;
  onSave: (profile: Profile) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Profile>(initial);
  const [picking, setPicking] = useState(false);
  const set = (patch: Partial<Profile>) => setDraft({ ...draft, ...patch });
  const idError = !draft.id ? "Name the router model." : !/^[a-z0-9][a-z0-9._-]*$/.test(draft.id) ? "Lowercase letters, digits, dots, hyphens, and underscores." : isNew && state.profiles.some((p) => p.id === draft.id) ? "That name is taken." : null;
  const move = (index: number, by: number) => {
    const next = [...draft.chain];
    const [entry] = next.splice(index, 1);
    next.splice(index + by, 0, entry);
    set({ chain: next });
  };
  return (
    <UiModal title={isNew ? "New router model" : `router/${initial.id}`} open onClose={onClose}>
      {isNew ? <Field label="Name" value={draft.id} onChangeText={(id) => set({ id: id.trim(), name: draft.name || `Router ${id.trim()}` })} placeholder="main" mono error={draft.id ? idError : null} hint={draft.id && !idError ? `Select it as router/${draft.id}` : undefined} /> : null}
      <Field label="Display name" value={draft.name} onChangeText={(name) => set({ name })} placeholder="Router main" />
      <Chips
        label="Pick"
        options={[
          { label: "best quota (balanced)", value: "balanced" as const },
          { label: "first with quota (ordered)", value: "ordered" as const },
        ]}
        value={draft.strategy}
        onChange={(strategy) => set({ strategy })}
      />
      <Row justify="space-between">
        <Txt size="sm" weight="500">
          Models
        </Txt>
        <Button small variant="outline" icon="Plus" label="Add model" onPress={() => setPicking(true)} />
      </Row>
      {draft.chain.map((entry, index) => (
        <EntryRow
          key={`${entry.model}#${entry.account ?? 1}#${index}`}
          entry={entry}
          providers={state.providers}
          onChange={(next) => set({ chain: draft.chain.map((e, i) => (i === index ? next : e)) })}
          onRemove={() => set({ chain: draft.chain.filter((_, i) => i !== index) })}
          onUp={index > 0 ? () => move(index, -1) : undefined}
          onDown={index < draft.chain.length - 1 ? () => move(index, 1) : undefined}
        />
      ))}
      <Chips
        label="When every model is exhausted"
        options={[
          { label: "default (wait)", value: "" },
          { label: "wait for a reset", value: "wait" },
          { label: "fail", value: "fail" },
        ]}
        value={draft.exhaustionPolicy ?? ""}
        onChange={(value) => set({ exhaustionPolicy: value ? (value as "wait" | "fail") : null })}
      />
      {draft.exhaustionPolicy !== "fail" ? (
        <Field
          label="Longest wait (minutes)"
          value={draft.maxWaitMinutes ? String(draft.maxWaitMinutes) : ""}
          onChangeText={(value) => set({ maxWaitMinutes: Number(value.replace(/[^0-9.]/g, "")) || null })}
          placeholder="No wait"
          hint="Without a limit the route does not wait."
        />
      ) : null}
      <Row justify="flex-end">
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label="Save" variant="primary" busy={busy} disabled={Boolean(idError) || draft.chain.length === 0} onPress={() => onSave({ ...draft, name: draft.name.trim() || `Router ${draft.id}` })} />
      </Row>
      <ModelPicker
        open={picking}
        title="Add a model"
        providers={state.providers}
        onPick={(entry) => {
          set({ chain: [...draft.chain, entry] });
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </UiModal>
  );
}
