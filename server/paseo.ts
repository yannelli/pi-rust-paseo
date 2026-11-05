import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** The Paseo API of the plugin's daemon session. Paseo provides `@getpaseo/plugin/server` to plugins. */
export type PaseoApi = PluginHandlerContext["paseo"];
