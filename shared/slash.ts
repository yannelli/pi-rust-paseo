// Parsing for the `/workflow` and `/pi-ext` composer commands.
import { DECISIONS, type Decision } from "./runs";

/** Splits on whitespace; single or double quotes group words, and a backslash escapes the next character. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      current += text[++i];
      started = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

export type WorkflowCommand =
  | { kind: "open" }
  | { kind: "runs" }
  | { kind: "new" }
  | { kind: "edit"; name: string }
  | { kind: "run"; name: string; inputs: Record<string, string>; background?: boolean; worktree?: { branch: string | null } }
  | { kind: "approve"; id: string | null; decision: Decision }
  | { kind: "control"; action: "stop" | "resume" | "skip"; id: string }
  | { kind: "status"; id: string | null };

export const WORKFLOW_USAGE =
  "/workflow [list | runs | new | edit <name> | run <name> [key=value …] [--fg] [--worktree[=branch]] | approve [<run id>] [run|skip|stop] | stop|resume|skip <run id> | status [<run id>]]";

export function parseWorkflowCommand(args: string): WorkflowCommand {
  const [verb = "", ...rest] = tokenize(args.trim());
  switch (verb.toLowerCase()) {
    case "":
    case "list":
      return { kind: "open" };
    case "runs":
      return { kind: "runs" };
    case "new":
      return { kind: "new" };
    case "edit":
      if (!rest[0]) throw new Error("Usage: /workflow edit <name>");
      return { kind: "edit", name: rest[0] };
    case "run": {
      const [name, ...pairs] = rest;
      if (!name) throw new Error("Usage: /workflow run <name> [key=value …]");
      const inputs: Record<string, string> = {};
      let background: boolean | undefined;
      let worktree: { branch: string | null } | undefined;
      for (const pair of pairs) {
        if (pair === "--worktree" || pair.startsWith("--worktree=")) {
          const branch = pair.slice("--worktree=".length).trim();
          worktree = { branch: pair.includes("=") && branch ? branch : null };
          continue;
        }
        if (pair === "--fg" || pair === "--foreground") {
          background = false;
          continue;
        }
        if (pair === "--bg" || pair === "--background") {
          background = true;
          continue;
        }
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error(`Expected key=value, got "${pair}". Quote values with spaces: change="fix the login bug".`);
        inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return { kind: "run", name, inputs, background, ...(worktree ? { worktree } : {}) };
    }
    case "approve": {
      let id: string | null = null;
      let decision: Decision = "run";
      for (const token of rest) {
        const lowered = token.toLowerCase();
        if ((DECISIONS as readonly string[]).includes(lowered)) decision = lowered as Decision;
        else if (lowered === "yes" || lowered === "approve") decision = "run";
        else id = token;
      }
      return { kind: "approve", id, decision };
    }
    case "stop":
    case "resume":
    case "skip": {
      if (!rest[0]) throw new Error(`Usage: /workflow ${verb} <run id>`);
      return { kind: "control", action: verb.toLowerCase() as "stop" | "resume" | "skip", id: rest[0] };
    }
    case "status":
      return { kind: "status", id: rest[0] ?? null };
    default:
      throw new Error(`Unknown subcommand "${verb}". ${WORKFLOW_USAGE}`);
  }
}

export type ExtensionCommand =
  | { kind: "open" }
  | { kind: "action"; action: "install" | "remove" | "enable" | "disable" | "update"; target: string; project: boolean };

export const EXTENSION_USAGE = "/pi-ext [install|remove|enable|disable|update <source or reference> [-l]]";

export function parseExtensionCommand(args: string): ExtensionCommand {
  const tokens = tokenize(args.trim());
  const project = tokens.includes("-l") || tokens.includes("--local");
  const [verb = "", target] = tokens.filter((token) => token !== "-l" && token !== "--local");
  if (!verb || verb === "list") return { kind: "open" };
  const action = verb.toLowerCase();
  if (!["install", "remove", "enable", "disable", "update"].includes(action)) {
    throw new Error(`Unknown subcommand "${verb}". ${EXTENSION_USAGE}`);
  }
  if (!target) throw new Error(`Usage: /pi-ext ${action} <source or reference> [-l]`);
  return { kind: "action", action: action as "install", target, project };
}
