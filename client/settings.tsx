// Plugin settings: where pi lives, and how runs and agent tools behave.
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { AGENT_TOOL_MODES, pluginSettings, type PluginSettingsValues } from "../shared/contracts";

const TOOL_LABELS: Record<(typeof AGENT_TOOL_MODES)[number], string> = {
  all: "Every agent",
  "non-pi": "Every agent except pi agents (they have the workflow tool)",
  off: "No agent",
};

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(pluginSettings);
  const [draft, setDraft] = useState<PluginSettingsValues | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  useEffect(() => {
    if (settings.status === "ready" && settings.revision !== revision) {
      setDraft(settings.values);
      setRevision(settings.revision);
    }
  }, [settings.status, settings.status === "ready" ? settings.revision : null]);
  if (settings.status === "loading" || !draft) {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title="Settings">
        <SettingsCard>
          <SettingsAction label="The stored settings cannot be read" hint={settings.error} actionLabel="Reset" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const save = (next: PluginSettingsValues) => {
    setDraft(next);
    void settings.save(next, settings.revision);
  };
  const saveText = (key: "piPath" | "agentDir" | "runnerPath") => (text: string) => setDraft({ ...draft, [key]: text });
  const textDirty = draft.piPath !== settings.values.piPath || draft.agentDir !== settings.values.agentDir || draft.runnerPath !== settings.values.runnerPath;
  return (
    <>
      <SettingsSection title="pi">
        <SettingsCard>
          <SettingsInput label="pi binary" hint="Empty: $PI_BIN, then pi on the daemon's PATH, ~/.local/bin, or ~/.cargo/bin." initialValue={draft.piPath} placeholder="/home/me/.local/bin/pi" onChangeText={saveText("piPath")} />
          <SettingsInput label="Agent directory" hint="Empty: $PI_CODING_AGENT_DIR, then ~/.pi/agent." initialValue={draft.agentDir} placeholder="~/.pi/agent" onChangeText={saveText("agentDir")} />
          <SettingsInput label="Workflow runner" hint="Empty: the pi-rust-ext binary of the installed workflows extension." initialValue={draft.runnerPath} placeholder="/path/to/pi-rust-ext" onChangeText={saveText("runnerPath")} />
          <SettingsAction label="Paths" hint={settings.saveError ?? undefined} actionLabel={settings.saving ? "Saving…" : "Save paths"} disabled={!textDirty || settings.saving} onPress={() => save(draft)} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Workflow runs">
        <SettingsCard>
          <SettingsSwitch
            label="Run in the background by default"
            hint="Background runs keep going when the plugin stops. Foreground runs belong to the plugin and stop as interrupted when it stops; they can resume."
            value={draft.defaultBackground}
            onValueChange={(value) => save({ ...draft, defaultBackground: value })}
          />
          <SettingsSwitch
            label="Report run ends to the agent that started the run"
            hint="When a Paseo agent starts a run with the pi_workflows tool, it gets the step reports as a message when the run ends, as pi does."
            value={draft.reportToAgent}
            onValueChange={(value) => save({ ...draft, reportToAgent: value })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Agent tools">
        <SettingsCard>
          <SettingsSelect
            label="Agents with the pi_workflows and pi_extensions tools"
            hint="Changes apply when an agent session opens next."
            value={draft.agentTools}
            options={AGENT_TOOL_MODES.map((mode) => ({ label: TOOL_LABELS[mode], value: mode }))}
            onValueChange={(value) => save({ ...draft, agentTools: value })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
