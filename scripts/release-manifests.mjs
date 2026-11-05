// The files a release changes: the package version (package.json and its lockfile) and the
// changelog, which gets the release notes at the top.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const manifestPaths = ["package.json", "package-lock.json", "CHANGELOG.md"];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const changelogHeader = "# Changelog";

async function readManifests(cwd) {
  const documents = await Promise.all(manifestPaths.slice(0, 2).map(async (path) => JSON.parse(await readFile(join(cwd, path), "utf8"))));
  const [pkg, lock] = documents;
  const versions = [pkg.version, lock.version, lock.packages?.[""]?.version];
  if (!versions.every((version) => typeof version === "string" && stableVersion.test(version))) throw new Error("Missing stable SemVer version in package manifests");
  if (new Set(versions).size !== 1) throw new Error("Package and lockfile versions must match");
  return documents;
}

export async function verifyConditions(_config, { cwd }) {
  const [pkg] = await readManifests(cwd);
  return pkg.version;
}

/** Puts `notes` (a `# <version>` section) under the changelog title as `## [version] - date`. */
export function addToChangelog(changelog, version, notes, date) {
  const body = notes
    .replace(/^# .*\n+/, "")
    .replace(/^## /gm, "### ")
    .trim();
  const entry = `## [${version}] - ${date}\n\n${body}\n`;
  const text = changelog.trim() ? changelog : `${changelogHeader}\n`;
  const at = text.indexOf("\n## ");
  if (at < 0) return `${text.trimEnd()}\n\n${entry}`;
  return `${text.slice(0, at).trimEnd()}\n\n${entry}\n${text.slice(at + 1)}`;
}

export async function prepare(_config, { cwd, nextRelease: { version, notes = "" } }) {
  if (!stableVersion.test(version)) throw new Error(`Invalid stable release version: ${version}`);
  const documents = await readManifests(cwd);
  documents[0].version = version;
  documents[1].version = version;
  documents[1].packages[""].version = version;
  for (const [index, path] of manifestPaths.slice(0, 2).entries()) await writeFile(join(cwd, path), `${JSON.stringify(documents[index], null, 2)}\n`);
  const changelogPath = join(cwd, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8").catch(() => "");
  await writeFile(changelogPath, addToChangelog(changelog, version, notes, new Date().toISOString().slice(0, 10)));
}
