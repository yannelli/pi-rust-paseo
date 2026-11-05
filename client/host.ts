// The client context of this installation, for components that navigate outside their surface
// (timeline cards, popovers).
import type { PluginClientContext, PluginScreenParams } from "@getpaseo/plugin/client";

export const SCREEN_ID = "manager";
export const PANEL_ID = "workflows";

export type ManagerTab = "overview" | "extensions" | "plugins" | "skills" | "context" | "workflows" | "runs" | "sessions";

/**
 * Params of the manager screen. `tab` picks the tab; `run` opens a run; `edit` (with `scope`)
 * opens a workflow in the editor; `cwd` sets the project directory.
 */
export interface ManagerParams {
  tab?: ManagerTab;
  run?: string;
  edit?: string;
  scope?: "global" | "project";
  cwd?: string;
}

let current: PluginClientContext | null = null;
let rememberedCwd = "";

/** The project directory last chosen on the Pi Rust screen, so it opens where you left it. */
export function lastCwd(): string {
  return rememberedCwd;
}

export function rememberCwd(cwd: string): void {
  rememberedCwd = cwd;
}

export function setClient(client: PluginClientContext | null): void {
  current = client;
}

export function openManager(params: ManagerParams = {}): void {
  const clean: PluginScreenParams = {};
  for (const [key, value] of Object.entries(params)) if (value) clean[key] = value;
  current?.openScreen({ screenId: SCREEN_ID, params: clean });
}

export function openRun(id: string): void {
  openManager({ tab: "runs", run: id });
}
