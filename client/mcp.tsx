// The MCP tab: pi's MCP servers for the chosen workspace, with on and off, sign-in and sign-out
// for OAuth servers, and adding and removing servers.
import type { RpcOutput } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import type { ScopeName } from "../shared/contracts";
import {
  MCP_EXPOSURES,
  NEW_SERVER_NAME,
  mcpAddRpc,
  mcpListRpc,
  mcpLoginCancelRpc,
  mcpLoginRedirectRpc,
  mcpLoginStartRpc,
  mcpLoginStatusRpc,
  mcpLogoutRpc,
  mcpRemoveRpc,
  mcpToggleRpc,
  parsePairs,
  type McpExposure,
  type McpServer,
} from "../shared/mcp";
import { poll, useRpcMutation, useRpcQuery } from "./queries";
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
  Notice,
  Row,
  Section,
  Spinner,
  Stack,
  StatusDot,
  Switch,
  Txt,
  UiModal,
  useUi,
  type Tone,
} from "./ui";

const INVALIDATES = ["mcp.list", "pi.doctor"] as const;
const APPLIES = "New pi sessions pick it up; running ones need /reload.";

type ListOutput = RpcOutput<typeof mcpListRpc>;

function stateOf(server: McpServer): { label: string; tone: Tone } {
  if (!server.enabled) return { label: "Off", tone: "muted" };
  switch (server.state) {
    case "connected":
      return { label: "Connected", tone: "success" };
    case "needs-auth":
      return { label: "Needs sign-in", tone: "warning" };
    case "connecting":
      return { label: "Connecting", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "disconnected":
      return { label: "Disconnected", tone: "danger" };
    case "closed":
      return { label: "Closed", tone: "danger" };
    default:
      return { label: server.state, tone: "muted" };
  }
}

export function McpTab({ cwd }: { cwd: string }) {
  const queries = useQueryClient();
  const input = { cwd: cwd || undefined };
  const list = useRpcQuery(mcpListRpc, input, { staleTime: 60_000 });
  const [failure, setFailure] = useState<{ title: string; output: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [signIn, setSignIn] = useState<McpServer | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);
  const report = (title: string) => (result: { ok: boolean; output: string }) => {
    setFailure(result.ok ? null : { title, output: result.output });
  };
  const toggle = useRpcMutation(mcpToggleRpc, {
    invalidates: INVALIDATES,
    success: (result) => `Saved in ${result.path}. ${APPLIES}`,
    onSuccess: (_result, { name, enabled }) => {
      queries.setQueryData<ListOutput>([mcpListRpc.name, input], (data) =>
        data ? { ...data, servers: data.servers.map((server) => (server.name === name ? { ...server, enabled, state: enabled ? "connecting" : "disabled", error: null } : server)) } : data,
      );
    },
  });
  const logout = useRpcMutation(mcpLogoutRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? result.output.split("\n").pop() || "Signed out." : null),
    onSuccess: (result, { name }) => report(`Sign-out of ${name} failed`)(result),
  });
  const remove = useRpcMutation(mcpRemoveRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? `Removed. ${APPLIES}` : null),
    onSuccess: (result, { name }) => {
      report(`Removing ${name} failed`)(result);
      setRemoving(null);
    },
  });
  const data = list.data;
  const on = data?.servers.filter((server) => server.enabled).length ?? 0;
  return (
    <Stack gap={16}>
      <Section
        title="MCP servers"
        description={data ? `${on} of ${data.servers.length} on. ${APPLIES}` : "pi connects to each server to check it, which can take a few seconds."}
        right={
          <Row gap={8}>
            <Button small variant="outline" icon="RefreshCw" label="Refresh" busy={list.isFetching} onPress={() => void list.refetch()} />
            <Button small variant="primary" icon="Plus" label="Add server" disabled={!data} onPress={() => setAdding(true)} />
          </Row>
        }
      >
        {!cwd ? (
          <Txt size="sm" tone="muted">
            {`Global servers from ${data?.globalConfig ?? "~/.pi/agent/mcp.json"}. Choose a workspace at the top to include its .pi/mcp.json.`}
          </Txt>
        ) : null}
        {failure ? (
          <Notice tone="danger" title={failure.title} action={<Button small variant="ghost" label="Dismiss" onPress={() => setFailure(null)} />}>
            {failure.output ? <CodeBlock text={failure.output} maxHeight={200} /> : null}
          </Notice>
        ) : null}
        {list.error ? <ErrorBox error={list.error} title="Could not list the MCP servers" /> : null}
        {list.isLoading ? <Spinner label="Connecting to the MCP servers" /> : null}
        {data && data.errors.length > 0 ? (
          <Notice tone="danger" title={data.errors.length === 1 ? "Config error" : `${data.errors.length} config errors`}>
            <Stack gap={4}>
              {data.errors.map((error) => (
                <Txt key={error} size="sm" mono selectable>
                  {error}
                </Txt>
              ))}
            </Stack>
          </Notice>
        ) : null}
        {data?.note ? <Notice tone="warning">{data.note}</Notice> : null}
        {data && data.servers.length === 0 ? (
          <Empty
            icon="Plug"
            title="No MCP servers yet"
            body={`Add a server here, or add it to ${data.globalConfig}${data.projectConfig ? ` or ${data.projectConfig}` : ""}.`}
            action={<Button small variant="primary" icon="Plus" label="Add server" onPress={() => setAdding(true)} />}
          />
        ) : null}
        {data?.servers.map((server) => (
          <ServerCard
            key={server.name}
            server={server}
            toggling={toggle.isPending && toggle.variables?.name === server.name}
            signingOut={logout.isPending && logout.variables?.name === server.name}
            onToggle={(enabled) => toggle.mutate({ cwd: cwd || undefined, name: server.name, enabled })}
            onSignIn={() => setSignIn(server)}
            onSignOut={() => logout.mutate({ cwd: cwd || undefined, name: server.name })}
            onRemove={() => setRemoving(server)}
          />
        ))}
      </Section>
      {adding && data ? <AddServer cwd={cwd} trusted={data.trusted} existing={data.servers} onClose={() => setAdding(false)} /> : null}
      {signIn ? <SignIn cwd={cwd} server={signIn} onClose={() => setSignIn(null)} /> : null}
      <ConfirmModal
        open={removing !== null}
        title="Remove MCP server"
        body={removing ? `Remove ${removing.name} from ${removing.source}? New pi sessions no longer load it.` : ""}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate({ cwd: cwd || undefined, scope: removing.scope === "project" ? "project" : "global", name: removing.name })}
      />
    </Stack>
  );
}

function ServerCard({
  server,
  toggling,
  signingOut,
  onToggle,
  onSignIn,
  onSignOut,
  onRemove,
}: {
  server: McpServer;
  toggling: boolean;
  signingOut: boolean;
  onToggle: (enabled: boolean) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onRemove: () => void;
}) {
  const { theme } = useUi();
  const [open, setOpen] = useState(false);
  const state = stateOf(server);
  const count = server.tools.length;
  const editable = server.scope === "global" || server.scope === "project";
  return (
    <Card style={{ gap: 6, opacity: server.enabled ? 1 : 0.8 }}>
      <Row gap={10} align="flex-start">
        <View style={{ paddingTop: 2 }}>
          <StatusDot tone={state.tone} />
        </View>
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Row gap={6}>
            <Txt weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
              {server.name}
            </Txt>
            <Badge label={server.scope} />
          </Row>
          <Txt size="xs" tone="muted" mono numberOfLines={1}>
            {server.transport}
          </Txt>
        </Stack>
        <Switch value={server.enabled} busy={toggling} disabled={!editable} label={`${server.enabled ? "Turn off" : "Turn on"} ${server.name}`} onChange={onToggle} />
      </Row>
      <View style={{ paddingLeft: 26, gap: 6 }}>
        <Row gap={8} wrap justify="space-between">
          <Row gap={6} wrap style={{ flexShrink: 1 }}>
            <Txt size="sm" weight="500" tone={state.tone}>
              {state.label}
            </Txt>
            <Txt size="sm" tone="muted">{`· ${server.exposure}`}</Txt>
            {count > 0 ? (
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Txt size="sm" tone="muted">{`· ${count} ${count === 1 ? "tool" : "tools"}`}</Txt>
                <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
            {server.resources ? <Txt size="sm" tone="muted">· offers resources</Txt> : null}
          </Row>
          {editable ? (
            <Row gap={6} style={{ marginLeft: "auto" }}>
              {server.oauth && server.enabled && server.state === "needs-auth" ? <Button small variant="primary" icon="LogIn" label="Sign in" onPress={onSignIn} /> : null}
              {server.oauth && server.state !== "needs-auth" ? <Button small variant="ghost" icon="LogOut" label="Sign out" busy={signingOut} onPress={onSignOut} /> : null}
              <Button small variant="ghost" icon="Trash2" label="Remove" onPress={onRemove} />
            </Row>
          ) : null}
        </Row>
        {server.error && server.enabled && server.state !== "needs-auth" ? (
          <Txt size="sm" tone="danger" selectable>
            {server.error}
          </Txt>
        ) : null}
        {server.override ? (
          <Txt size="xs" tone="muted" selectable>
            {`Project override: ${server.override}`}
          </Txt>
        ) : null}
        {open ? (
          <Row gap={4} wrap>
            {server.tools.map((tool) => (
              <Badge key={tool} label={server.toolExposure?.[tool] ? `${tool} · ${server.toolExposure[tool]}` : tool} />
            ))}
          </Row>
        ) : null}
      </View>
    </Card>
  );
}

function SignIn({ cwd, server, onClose }: { cwd: string; server: McpServer; onClose: () => void }) {
  const { theme } = useUi();
  const queries = useQueryClient();
  const [id, setId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const start = useRpcMutation(mcpLoginStartRpc, { onSuccess: (result) => setId(result.id) });
  const cancel = useRpcMutation(mcpLoginCancelRpc, { toastErrors: false });
  const redirect = useRpcMutation(mcpLoginRedirectRpc, { toastErrors: false });
  const begin = () => {
    setId(null);
    setPasted("");
    redirect.reset();
    start.mutate({ cwd: cwd || undefined, name: server.name });
  };
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    begin();
  }, []);
  const status = useRpcQuery(mcpLoginStatusRpc, { id: id ?? "" }, { enabled: Boolean(id), refetchInterval: (query) => poll(!query.state.data || ["starting", "waiting"].includes(query.state.data.state)) });
  const login = status.data ?? start.data;
  const active = !login || login.state === "starting" || login.state === "waiting";
  const ended = login?.state;
  useEffect(() => {
    if (ended === "done" || ended === "failed") for (const name of INVALIDATES) void queries.invalidateQueries({ queryKey: [name] });
  }, [ended]);
  const close = () => {
    if (id && active) cancel.mutate({ id });
    onClose();
  };
  return (
    <UiModal title={`Sign in to ${server.name}`} open onClose={close}>
      <Stack gap={12}>
        {start.error ? <ErrorBox error={start.error} /> : null}
        {status.error ? <ErrorBox error={status.error} /> : null}
        {!login && !start.error ? <Spinner label="Starting the sign-in" /> : null}
        {login?.state === "starting" ? <Spinner label={`pi is connecting to ${server.name}`} /> : null}
        {login?.state === "waiting" && login.url ? (
          <>
            <Txt size="sm">1. Open the sign-in page and sign in.</Txt>
            <Row gap={8} wrap>
              <Button small variant="primary" icon="ExternalLink" label="Open sign-in page" onPress={() => void openExternalUrl(login.url!)} />
            </Row>
            <CodeBlock text={login.url} maxHeight={80} />
            <Txt size="sm">2. If the browser runs on another device, the page it opens after you sign in does not load. Copy that page's address from the address bar and paste it here.</Txt>
            <Field value={pasted} onChangeText={setPasted} placeholder="http://127.0.0.1:…/callback?code=…" mono error={redirect.error ? redirect.error.message : null} />
            <Row gap={8} justify="space-between" wrap>
              <Row gap={6}>
                <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
                <Txt size="xs" tone="muted">
                  Waiting for the browser
                </Txt>
              </Row>
              <Row gap={8}>
                <Button label="Cancel" variant="ghost" onPress={close} />
                <Button label="Finish sign-in" variant="primary" disabled={!pasted.trim()} busy={redirect.isPending} onPress={() => redirect.mutate({ id: login.id, url: pasted.trim() })} />
              </Row>
            </Row>
          </>
        ) : null}
        {login?.state === "done" ? <Notice tone="success" title="Signed in">{login.message ?? `pi can use ${server.name} now.`}</Notice> : null}
        {login?.state === "failed" ? <Notice tone="danger" title="Sign-in failed">{login.message ?? "pi ended the sign-in without a message."}</Notice> : null}
        {login?.state === "cancelled" ? <Notice tone="muted">{login.message ?? "Sign-in cancelled."}</Notice> : null}
        {!active || start.error ? (
          <Row gap={8} justify="flex-end">
            {login?.state === "failed" || start.error ? <Button label="Try again" variant="outline" icon="RotateCcw" onPress={begin} /> : null}
            <Button label="Close" variant="primary" onPress={close} />
          </Row>
        ) : null}
      </Stack>
    </UiModal>
  );
}

const EXPOSURE_LABELS: Record<McpExposure, string> = { codemode: "Code mode", deferred: "Deferred", direct: "Direct", hidden: "Hidden" };

function AddServer({ cwd, trusted, existing, onClose }: { cwd: string; trusted: boolean; existing: McpServer[]; onClose: () => void }) {
  const canProject = Boolean(cwd) && trusted;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ScopeName>(canProject ? "project" : "global");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [exposure, setExposure] = useState<McpExposure>("codemode");
  const add = useRpcMutation(mcpAddRpc, {
    invalidates: INVALIDATES,
    success: (result) => (result.ok ? `Added ${name}. ${APPLIES}` : null),
    onSuccess: (result) => {
      if (result.ok) onClose();
    },
  });
  const trimmed = name.trim();
  const nameError = trimmed && !NEW_SERVER_NAME.test(trimmed) ? "Use letters, digits, dots, dashes, and underscores, starting with a letter or digit." : null;
  const replaces = existing.find((server) => server.name === trimmed && server.scope === scope);
  const envError = transport === "stdio" ? parsePairs(env, "environment variable").error : null;
  const headerError = transport === "http" ? parsePairs(headers, "header").error : null;
  const ready = Boolean(trimmed) && !nameError && !envError && !headerError && (transport === "http" ? Boolean(url.trim()) : Boolean(command.trim()));
  const submit = () =>
    add.mutate({
      cwd: cwd || undefined,
      scope,
      name: trimmed,
      transport,
      url: url.trim(),
      command: command.trim(),
      args: args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean),
      env,
      headers,
      exposure,
    });
  return (
    <UiModal title="Add an MCP server" open onClose={onClose}>
      <Stack gap={12}>
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="docs"
          error={nameError}
          hint={replaces ? `This replaces the ${replaces.scope} server ${replaces.name}.` : undefined}
          autoFocus
        />
        {canProject ? (
          <Chips
            label="Where"
            options={[
              { label: "This workspace", value: "project" as const },
              { label: "Global", value: "global" as const },
            ]}
            value={scope}
            onChange={setScope}
          />
        ) : null}
        <Chips
          label="Type"
          options={[
            { label: "HTTP URL", value: "http" as const },
            { label: "Command (stdio)", value: "stdio" as const },
          ]}
          value={transport}
          onChange={setTransport}
        />
        {transport === "http" ? (
          <>
            <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" mono />
            <Field
              label="Headers"
              value={headers}
              onChangeText={setHeaders}
              placeholder={"X-Team=core\nAuthorization=Bearer ${API_TOKEN}"}
              multiline
              minHeight={64}
              mono
              error={headerError}
              hint="One KEY=VALUE per line. Without an Authorization header, pi signs in with OAuth when the server asks."
            />
          </>
        ) : (
          <>
            <Field label="Command" value={command} onChangeText={setCommand} placeholder="npx" mono />
            <Field label="Arguments" value={args} onChangeText={setArgs} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."} multiline minHeight={64} mono hint="One argument per line." />
            <Field label="Environment" value={env} onChangeText={setEnv} placeholder="API_KEY=${MY_API_KEY}" multiline minHeight={64} mono error={envError} hint="One KEY=VALUE per line." />
          </>
        )}
        <Chips label="Exposure" options={MCP_EXPOSURES.map((value) => ({ label: EXPOSURE_LABELS[value], value }))} value={exposure} onChange={setExposure} />
        {add.data && !add.data.ok ? <ErrorBox error={add.data.output || `pi exited with ${add.data.code}.`} /> : null}
        <Row gap={8} justify="flex-end">
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Add server" variant="primary" disabled={!ready} busy={add.isPending} onPress={submit} />
        </Row>
      </Stack>
    </UiModal>
  );
}
