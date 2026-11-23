// MCP servers of pi: `pi mcp list --json`, turning servers on and off in mcp.json, adding and
// removing them, and OAuth sign-in sessions of `pi mcp login`.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { CommandResultSchema, ScopeArg } from "./contracts";

export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** Names the Add form accepts. pi accepts more, so other rules apply to existing servers. */
export const NEW_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// eslint-disable-next-line no-control-regex
const ServerName = z.string().min(1).max(200).refine((name) => name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name), "Invalid server name.");

export const McpServerSchema = z.object({
  name: z.string(),
  /** `global` or `project`. */
  scope: z.string(),
  /** The mcp.json that defines the server. */
  source: z.string(),
  /** The project mcp.json that overrides `enabled`, `exposure`, or `toolExposure` of a global server. */
  override: z.string().nullable(),
  enabled: z.boolean(),
  exposure: z.string(),
  /** The URL, or the command line. */
  transport: z.string(),
  /** connected, needs-auth, disabled, failed, disconnected, connecting, or closed. */
  state: z.string(),
  tools: z.array(z.string()),
  /** Tools whose exposure differs from the server's. */
  toolExposure: z.record(z.string(), z.string()).nullable(),
  resources: z.boolean(),
  error: z.string().nullable(),
  /** An HTTP server without an Authorization header or `auth`, so it signs in with OAuth. */
  oauth: z.boolean(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const mcpListRpc = defineRpc({
  name: "mcp.list",
  input: z.object({ cwd: z.string().optional() }),
  output: z.object({
    servers: z.array(McpServerSchema),
    errors: z.array(z.string()),
    note: z.string().nullable(),
    /** pi reads the workspace's .pi/mcp.json, since the workspace is trusted. */
    trusted: z.boolean(),
    globalConfig: z.string(),
    projectConfig: z.string().nullable(),
  }),
});

export const mcpToggleRpc = defineRpc({
  name: "mcp.toggle",
  input: z.object({ cwd: z.string().optional(), name: ServerName, enabled: z.boolean() }),
  output: z.object({ path: z.string() }),
});

export const mcpAddRpc = defineRpc({
  name: "mcp.add",
  input: z.object({
    cwd: z.string().optional(),
    scope: ScopeArg,
    name: z.string().regex(NEW_SERVER_NAME, "Use letters, digits, dots, dashes, and underscores, starting with a letter or digit."),
    transport: z.enum(["http", "stdio"]),
    url: z.string().max(2000).default(""),
    command: z.string().max(1000).default(""),
    args: z.array(z.string().max(1000)).max(100).default([]),
    /** KEY=VALUE lines. */
    env: z.string().max(20_000).default(""),
    /** KEY=VALUE lines. */
    headers: z.string().max(20_000).default(""),
    exposure: z.enum(MCP_EXPOSURES).default("codemode"),
  }),
  output: CommandResultSchema,
});

export const mcpRemoveRpc = defineRpc({
  name: "mcp.remove",
  input: z.object({ cwd: z.string().optional(), scope: ScopeArg, name: ServerName }),
  output: CommandResultSchema,
});

export const mcpLogoutRpc = defineRpc({
  name: "mcp.logout",
  input: z.object({ cwd: z.string().optional(), name: ServerName }),
  output: CommandResultSchema,
});

export const MCP_LOGIN_STATES = ["starting", "waiting", "done", "failed", "cancelled"] as const;
export type McpLoginState = (typeof MCP_LOGIN_STATES)[number];

export const McpLoginSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** starting: pi connects; waiting: pi waits for the browser; then done, failed, or cancelled. */
  state: z.enum(MCP_LOGIN_STATES),
  /** The authorization URL pi printed. */
  url: z.string().nullable(),
  /** The last line of pi's output once it ends. */
  message: z.string().nullable(),
  output: z.string(),
});
export type McpLogin = z.infer<typeof McpLoginSchema>;

const LoginId = z.string().regex(/^[0-9a-f]{16}$/);

export const mcpLoginStartRpc = defineRpc({
  name: "mcp.login.start",
  input: z.object({ cwd: z.string().optional(), name: ServerName }),
  output: McpLoginSchema,
});

export const mcpLoginStatusRpc = defineRpc({
  name: "mcp.login.status",
  input: z.object({ id: LoginId }),
  output: McpLoginSchema,
});

/** Sends the address the browser was redirected to on to pi's loopback listener. */
export const mcpLoginRedirectRpc = defineRpc({
  name: "mcp.login.redirect",
  input: z.object({ id: LoginId, url: z.string().min(1).max(8000) }),
  output: McpLoginSchema,
});

export const mcpLoginCancelRpc = defineRpc({
  name: "mcp.login.cancel",
  input: z.object({ id: LoginId }),
  output: McpLoginSchema,
});

/** `KEY=VALUE` lines as a record; `error` names the first bad line. Blank lines are skipped. */
export function parsePairs(text: string, what: "environment variable" | "header"): { pairs: [string, string][]; error: string | null } {
  const key = what === "header" ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  const pairs: [string, string][] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    const name = equals > 0 ? line.slice(0, equals).trim() : "";
    if (!name) return { pairs, error: `Line ${index + 1} is not KEY=VALUE.` };
    if (!key.test(name)) return { pairs, error: `Line ${index + 1}: "${name}" is not a valid ${what} name.` };
    pairs.push([name, line.slice(equals + 1).trim()]);
  }
  return { pairs, error: null };
}
