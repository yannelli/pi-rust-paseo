// Project trust as pi resolves it without a UI (crates/pi-coding-agent/src/resources/trust.rs):
// no trust-requiring project files, else the closest saved decision, else `defaultProjectTrust`.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { agentDir } from "./pi";

const TRUST_REQUIRING = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];

function canonical(dir: string): string {
  try {
    return realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

function readJsonSync(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function needsTrust(cwd: string): boolean {
  const config = path.join(cwd, ".pi");
  if (TRUST_REQUIRING.some((entry) => existsSync(path.join(config, entry)))) return true;
  const userSkills = path.join(canonical(homedir()), ".agents", "skills");
  return ancestors(cwd).some((dir) => {
    const skills = path.join(dir, ".agents", "skills");
    return skills !== userSkills && existsSync(skills);
  });
}

export function projectTrusted(cwd: string): boolean {
  const dir = canonical(cwd);
  if (!needsTrust(dir)) return true;
  return decision(dir);
}

/** Whether pi will trust the workspace once it has files that need trust, such as SYSTEM.md. */
export function trustedOnceNeeded(cwd: string): boolean {
  return decision(canonical(cwd));
}

function decision(dir: string): boolean {
  const saved = readJsonSync(path.join(agentDir(), "trust.json"));
  if (saved && typeof saved === "object") {
    const map = saved as Record<string, unknown>;
    for (const candidate of ancestors(dir)) {
      const decision = map[candidate];
      if (typeof decision === "boolean") return decision;
    }
  }
  const settings = readJsonSync(path.join(agentDir(), "settings.json")) as { defaultProjectTrust?: unknown } | null;
  return settings?.defaultProjectTrust === "always";
}
