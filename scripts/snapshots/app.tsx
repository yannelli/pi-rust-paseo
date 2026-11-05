// The snapshot app: renders one plugin surface, chosen by the URL query, with the plugin's
// real components. `view` is manager, panel, card, or composer; theme is dark or light.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { setClient } from "../../client/host";
import { ManagerScreen, WorkflowsPanel } from "../../client/manager";
import { startStatusPills } from "../../client/status";
import { RunCardRow } from "../../client/timeline-card";
import { callRpc } from "./mocks/client";
import { Icon } from "./mocks/ui";

// Paseo's default dark and light palettes, as plugins receive them.
const themes: Record<string, any> = {
  dark: { colors: { surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", border: "#252B2A", foreground: "#fafafa", foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b" } },
  light: { colors: { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7", foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff", statusSuccess: "#3e704a", statusWarning: "#7b5d39", statusDanger: "#9d433b" } },
};

const q = new URLSearchParams(location.search);
const theme = themes[q.get("theme") ?? "dark"];
const compact = q.get("compact") === "1";
const width = compact ? 390 : Number(q.get("w") ?? 1280);
(window as any).__theme = theme;
(window as any).__compact = compact;
(window as any).__workspace = { directory: q.get("dir") ?? "", name: "demo" };
document.body.style.background = theme.colors.surface0;
const layout = { compact, platform: "web" as const };
const host = { id: "demo", label: "devbox" };
const navigation = { openAgent() {}, openWorkspace() {} };
setClient({ openScreen() {} } as any);
const params: Record<string, string> = {};
for (const key of ["tab", "run", "cwd", "edit", "scope"]) if (q.get(key)) params[key] = q.get(key)!;
const view = q.get("view") ?? "manager";
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const tab = { setModified() {}, state: undefined, setState() {} };
const common = { theme, layout, host, navigation } as any;

/** A composer like Paseo's: built-in pills, the Pi Rust pill, and its open popover. */
function Composer() {
  const [pills, setPills] = useState<any[]>([]);
  useEffect(
    () =>
      startStatusPills({
        rpc: callRpc,
        addComposerPill(contribution: any) {
          const entry = { ...contribution };
          setPills((current) => [...current, entry]);
          return {
            update(patch: any) {
              Object.assign(entry.button, patch);
              setPills((current) => [...current]);
            },
            remove() {
              setPills((current) => current.filter((x) => x !== entry));
            },
          };
        },
      } as any),
    [],
  );
  const c = theme.colors;
  const pill = pills[0];
  const PillIcon = pill?.button.icon;
  const Content = pill?.button.behavior.Content;
  const target = { context: "agent", workspaceId: pill?.workspaceId, agentId: pill?.agentId };
  const chip = (label: string, icon: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border }}>
      <Icon name={icon} size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ padding: compact ? 12 : 20, gap: 10, justifyContent: "flex-end", minHeight: "100vh" as any }}>
      {Content ? (
        <View nativeID="popover" style={{ alignSelf: "flex-start", backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 14, padding: 14, maxWidth: compact ? 366 : undefined, boxShadow: "0 18px 50px rgba(0,0,0,0.35)" } as any}>
          <Content {...common} {...target} close={() => {}} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {chip("Tasks 3/5", "ListChecks")}
        {chip("Subagents", "Bot")}
        {pill ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.accent }}>
            <PillIcon {...common} {...target} size={14} color={c.foreground} />
            <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{pill.button.label}</Text>
            <Icon name="ChevronUp" size={12} color={c.foregroundMuted} />
          </View>
        ) : null}
      </View>
      <View style={{ height: 76, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 14 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 14 }}>Message the agent…</Text>
      </View>
    </View>
  );
}

function App() {
  let body: any = null;
  if (view === "manager") body = <ManagerScreen {...common} params={params} />;
  if (view === "panel") body = <WorkflowsPanel {...common} workspaceId="demo" context="workspace" params={{}} revision={0} tab={tab} />;
  if (view === "card") {
    body = (
      <View style={{ padding: 16 }}>
        <RunCardRow {...common} agentId="demo" timestamp={new Date()} item={{ type: "plugin", kind: "workflow-run", version: 1, data: { runId: q.get("run") ?? "", workflow: "" } }} />
      </View>
    );
  }
  if (view === "composer") body = <Composer />;
  return <View style={{ width, minHeight: "100vh" as any, backgroundColor: theme.colors.surface0 }}>{body}</View>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queries}>
    <App />
  </QueryClientProvider>,
);
