// Parsers for the text output of pi commands that have no JSON mode. The formats come from
// crates/pi-coding-agent/src/packages (config_cmd.rs, cli.rs, cli_marketplace.rs).
import type { ExtensionInfo, MarketplaceEntry, ModelInfo, PackageInfo } from "../shared/contracts";

/** `pi extensions list`: `[x] <reference>  (<source>)` per line. */
export function parseExtensionList(text: string): ExtensionInfo[] {
  const out: ExtensionInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\[(x| )\] (.+?)  \((.*)\)\s*$/.exec(line.trimEnd());
    if (!match) continue;
    const reference = match[2];
    out.push({
      reference,
      name: extensionName(reference),
      enabled: match[1] === "x",
      source: match[3],
      builtin: reference.startsWith("builtin:"),
    });
  }
  return out;
}

/** `native:@scope/pkg/name` → `name`; `builtin:mcp` → `mcp`; a path → its file stem. */
export function extensionName(reference: string): string {
  const withoutKind = reference.replace(/^(native|builtin|npm|git):/, "");
  const last = withoutKind.split(/[\\/]/).filter(Boolean).pop() ?? withoutKind;
  return last.replace(/\.(ts|js|mjs|cjs)$/, "");
}

/** `pi list`: a heading per scope, `  <source>[ (filtered)]`, then `    <installed path>`. */
export function parsePackageList(text: string): PackageInfo[] {
  const out: PackageInfo[] = [];
  let scope: PackageInfo["scope"] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "User packages:") {
      scope = "global";
      continue;
    }
    if (line === "Project packages:") {
      scope = "project";
      continue;
    }
    if (!scope) continue;
    if (line.startsWith("    ") && out.length > 0) {
      out[out.length - 1].path = line.trim();
      continue;
    }
    if (line.startsWith("  ") && line.trim().length > 0) {
      const entry = line.trim();
      const filtered = entry.endsWith(" (filtered)");
      out.push({ source: filtered ? entry.slice(0, -" (filtered)".length) : entry, path: null, filtered, scope });
    }
  }
  return out;
}

/** `pi extensions search`: `name (version)[ [installed: tag]]` then an indented description. */
export function parseSearch(text: string): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const head = /^(\S+) \(([^)]*)\)(?: \[installed: ([^\]]+)\])?$/.exec(line);
    if (head) {
      out.push({ name: head[1], version: head[2], installed: head[3] ?? null, description: "" });
      continue;
    }
    if (line.startsWith("  ") && out.length > 0) {
      const last = out[out.length - 1];
      last.description = last.description ? `${last.description} ${line.trim()}` : line.trim();
    }
  }
  return out;
}

/** `pi extensions info`: a title line, a description, then `Key: value` lines. */
export function parseInfo(text: string): { title: string; description: string; fields: Record<string, string> } {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const fields: Record<string, string> = {};
  const description: string[] = [];
  let title = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!title) {
      title = line.trim();
      continue;
    }
    const field = /^([A-Z][A-Za-z ]{1,24}): (.*)$/.exec(line);
    if (field) fields[field[1]] = field[2];
    else if (Object.keys(fields).length === 0) description.push(line.trim());
  }
  return { title, description: description.join(" "), fields };
}

/** `pi --list-models`: a header, then `provider model context max-out thinking images` columns. */
export function parseModels(text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 6 || parts[0] === "provider") continue;
    const [provider, id, context, maxOut, thinking, images] = parts;
    out.push({ provider, id, context, maxOut, thinking: thinking === "yes", images: images === "yes" });
  }
  return out;
}
