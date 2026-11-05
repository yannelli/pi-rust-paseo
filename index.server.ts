import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { pluginSettings } from "./shared/contracts";
import { registerHandlers } from "./server/handlers";
import { applySettings, currentSettings } from "./server/pi";
import { releaseRuns, startWatcher } from "./server/runs";
import { agentTools } from "./server/tools";

export default function contribute(server: PluginServerContext) {
  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => {
    paseo = api;
  };

  const settings = server.registerSettings(pluginSettings);
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") applySettings(state.values);
  });
  void settings.read().then((state) => {
    if (state.status === "ready") applySettings(state.values);
  });

  registerHandlers(server, remember);

  server.addHook("agent.open.before", async ({ request }, context) => {
    remember(context.paseo);
    const mode = currentSettings().agentTools;
    if (mode === "off" || (mode === "non-pi" && request.provider === "pi")) return;
    return { ...request, tools: [...request.tools, ...agentTools] };
  });

  const stopWatcher = startWatcher(() => paseo);

  return async () => {
    stopWatcher();
    unsubscribe();
    await releaseRuns();
  };
}
