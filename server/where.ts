// Facts about a directory that decide where pi reads project files: its git checkout, whether
// it is a linked worktree and of which main checkout, and whether pi trusts it.
import { execFile } from "node:child_process";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { dirInfoRpc } from "../shared/contracts";
import { exists } from "./fsutil";
import { projectDir } from "./pi";
import { projectTrusted } from "./trust";

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

export async function dirInfo({ cwd }: RpcInput<typeof dirInfoRpc>): Promise<RpcOutput<typeof dirInfoRpc>> {
  const resolved = path.resolve(cwd);
  if (!(await exists(resolved))) {
    return { cwd: resolved, exists: false, trusted: false, hasProjectPi: false, git: null };
  }
  const [top, common, branch, status] = await Promise.all([
    git(resolved, ["rev-parse", "--show-toplevel"]),
    git(resolved, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(resolved, ["branch", "--show-current"]),
    git(resolved, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  let info: RpcOutput<typeof dirInfoRpc>["git"] = null;
  if (top && common) {
    // A linked worktree shares the main checkout's `.git`; the main checkout owns it.
    const mainCheckout = path.basename(common) === ".git" ? path.dirname(common) : top;
    info = {
      top,
      branch: branch || null,
      isWorktree: path.resolve(mainCheckout) !== path.resolve(top),
      mainCheckout,
      dirty: Boolean(status),
    };
  }
  return {
    cwd: resolved,
    exists: true,
    trusted: projectTrusted(resolved),
    hasProjectPi: await exists(projectDir(resolved)),
    git: info,
  };
}

/** Creates a Paseo worktree of the project that holds `cwd`, branched off its default branch. */
export async function createRunWorktree(paseo: PaseoApi, cwd: string, branchName: string | undefined, title: string): Promise<{ id: string; directory: string }> {
  const info = await dirInfo({ cwd });
  if (!info.git) throw new Error(`${cwd} is not in a git checkout, so it cannot have worktrees.`);
  const handle = await paseo.workspaces.create({
    title,
    source: { kind: "worktree", cwd: info.git.mainCheckout, action: "branch-off", branchName: branchName || undefined },
  });
  const directory = handle.directory ?? (await handle.refresh())?.workspaceDirectory ?? null;
  if (!directory) throw new Error("Paseo created the worktree but did not report its directory.");
  return { id: handle.id, directory };
}
