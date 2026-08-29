import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitChangelogs } from "@takazudo/zudo-doc/integrations/changelog";
import { parseFrontmatter } from "@takazudo/zfb/frontmatter";
import { CHANGELOGS } from "../changelog-config.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DOC_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const REPOSITORY_ROOT = resolve(DOC_ROOT, "..");

const CONFIG_KEYS = ["slug", "sourceDir", "outputFile", "packageName"];
const RELEASE_FRONTMATTER_KEYS = ["title", "description", "sidebar_position", "category"];
const PLAIN_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const CANONICAL_CHANGELOGS = CHANGELOGS.map((entry) => ({ ...entry }));

export class ChangelogDriftError extends Error {
  /** @param {string[]} diagnostics */
  constructor(diagnostics) {
    super(diagnostics.join("\n"));
    this.name = "ChangelogDriftError";
    this.diagnostics = diagnostics;
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return (
    path !== "" &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    path !== ".." &&
    !isAbsolute(path)
  );
}

/**
 * @param {readonly unknown[]} changelogs
 * @param {{projectRoot: string, repositoryRoot: string}} roots
 */
export function validateChangelogConfig(changelogs, roots) {
  const diagnostics = [];
  if (!Array.isArray(changelogs)) {
    throw new ChangelogDriftError(["Changelog configuration must be an array."]);
  }
  if (changelogs.length !== CANONICAL_CHANGELOGS.length) {
    diagnostics.push(
      `Expected exactly ${CANONICAL_CHANGELOGS.length} changelog entries; found ${changelogs.length}.`,
    );
  }

  const seen = new Map(CONFIG_KEYS.map((key) => [key, new Set()]));
  for (let index = 0; index < changelogs.length; index += 1) {
    const entry = changelogs[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(`Changelog entry ${index + 1} must be an object.`);
      continue;
    }
    const keys = Object.keys(entry).sort((left, right) => left.localeCompare(right, "en"));
    const expectedKeys = [...CONFIG_KEYS].sort((left, right) => left.localeCompare(right, "en"));
    if (keys.join("\0") !== expectedKeys.join("\0")) {
      diagnostics.push(
        `Changelog entry ${index + 1} must have exactly: ${CONFIG_KEYS.join(", ")}.`,
      );
    }
    for (const key of CONFIG_KEYS) {
      const value = entry[key];
      if (typeof value !== "string" || value.length === 0) {
        diagnostics.push(`Changelog entry ${index + 1} has an invalid ${key}.`);
        continue;
      }
      const values = seen.get(key);
      if (values.has(value)) diagnostics.push(`Duplicate changelog ${key}: ${value}.`);
      values.add(value);
    }
    const expected = CANONICAL_CHANGELOGS[index];
    if (expected) {
      for (const key of CONFIG_KEYS) {
        if (entry[key] !== expected[key]) {
          diagnostics.push(`Changelog entry ${index + 1} ${key} must be ${expected[key]}.`);
        }
      }
    }
    if (typeof entry.sourceDir === "string") {
      const source = resolve(roots.projectRoot, entry.sourceDir);
      if (!isInside(roots.projectRoot, source))
        diagnostics.push(`Changelog source escapes the Docs root: ${entry.sourceDir}.`);
    }
    if (typeof entry.outputFile === "string") {
      const output = resolve(roots.projectRoot, entry.outputFile);
      if (!isInside(roots.repositoryRoot, output))
        diagnostics.push(`Changelog output escapes the repository root: ${entry.outputFile}.`);
    }
  }
  if (diagnostics.length > 0) throw new ChangelogDriftError(diagnostics);
}

async function requireReleaseSource(projectRoot, entry) {
  const source = resolve(projectRoot, entry.sourceDir);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ChangelogDriftError([
        `Changelog source is missing for ${entry.slug}: ${entry.sourceDir}.`,
      ]);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ChangelogDriftError([
      `Changelog source must be a real directory for ${entry.slug}: ${entry.sourceDir}.`,
    ]);
  }
  const [realProjectRoot, realSource] = await Promise.all([
    realpath(projectRoot),
    realpath(source),
  ]);
  if (!isInside(realProjectRoot, realSource)) {
    throw new ChangelogDriftError([
      `Changelog source resolves outside the Docs root for ${entry.slug}: ${entry.sourceDir}.`,
    ]);
  }
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const releases = new Set();
  for (const candidate of entries) {
    if (
      !/\.mdx?$/u.test(candidate.name) ||
      candidate.name === "index.mdx" ||
      candidate.name === "index.md" ||
      candidate.name.startsWith("_")
    )
      continue;
    const candidatePath = join(source, candidate.name);
    const candidateInfo = await lstat(candidatePath);
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
      throw new ChangelogDriftError([
        `Changelog release must be a real file for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    const contents = await readFile(candidatePath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
    if (!frontmatter) {
      throw new ChangelogDriftError([
        `Changelog release has malformed frontmatter for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    const rawKeys = [];
    for (const line of frontmatter[1].split(/\r?\n/u)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const key = /^([A-Za-z_][\w-]*)\s*:\s*.*$/u.exec(line);
      if (!key) {
        throw new ChangelogDriftError([
          `Changelog release has malformed frontmatter for ${entry.slug}: ${candidate.name}.`,
        ]);
      }
      rawKeys.push(key[1]);
    }
    let parsed;
    try {
      parsed = parseFrontmatter(contents);
    } catch {
      throw new ChangelogDriftError([
        `Changelog release has malformed frontmatter for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    const keys = Object.keys(parsed.data);
    if (rawKeys.join("\0") !== keys.join("\0")) {
      throw new ChangelogDriftError([
        `Changelog release has malformed frontmatter for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    if (keys.join("\0") !== RELEASE_FRONTMATTER_KEYS.join("\0")) {
      throw new ChangelogDriftError([
        `Changelog release must have exactly ${RELEASE_FRONTMATTER_KEYS.join(", ")} for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    const version = parsed.data.title;
    const filenameVersion = candidate.name.replace(/\.mdx?$/u, "");
    if (typeof version !== "string" || !PLAIN_SEMVER.test(version) || version !== filenameVersion) {
      throw new ChangelogDriftError([
        `Changelog release title must be an exact plain SemVer matching its filename for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    if (typeof parsed.data.description !== "string" || parsed.data.description.trim() === "") {
      throw new ChangelogDriftError([
        `Changelog release description must be nonempty for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    if (
      typeof parsed.data.sidebar_position !== "string" ||
      !/^[0-9]+$/u.test(parsed.data.sidebar_position)
    ) {
      throw new ChangelogDriftError([
        `Changelog release sidebar_position must be numeric for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    if (parsed.data.category !== "changelog") {
      throw new ChangelogDriftError([
        `Changelog release category must be changelog for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
    if (releases.has(version)) {
      throw new ChangelogDriftError([
        `Duplicate changelog release version for ${entry.slug}: ${version}.`,
      ]);
    }
    releases.add(version);
    const dates = [...parsed.body.matchAll(/^Released: ([0-9]{4}-[0-9]{2}-[0-9]{2})\r?$/gmu)];
    if (dates.length > 1) {
      throw new ChangelogDriftError([
        `Changelog release must contain at most one standalone Released: YYYY-MM-DD line for ${entry.slug}: ${candidate.name}.`,
      ]);
    }
  }
  if (releases.size === 0) {
    throw new ChangelogDriftError([
      `Changelog source has no release entries for ${entry.slug}: ${entry.sourceDir}.`,
    ]);
  }
}

async function readArtifact(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { diagnostic: `${label} is missing.` };
    return { diagnostic: `${label} could not be read (${error?.code ?? "unknown error"}).` };
  }
}

async function requireSafeCommittedOutput(projectRoot, repositoryRoot, entry) {
  const output = resolve(projectRoot, entry.outputFile);
  let info;
  try {
    info = await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ChangelogDriftError([
      `Committed changelog must be a real file for ${entry.slug}: ${entry.outputFile}.`,
    ]);
  }
  const [realRepositoryRoot, realOutputParent] = await Promise.all([
    realpath(repositoryRoot),
    realpath(dirname(output)),
  ]);
  if (!isInside(realRepositoryRoot, realOutputParent)) {
    throw new ChangelogDriftError([
      `Committed changelog resolves outside the repository for ${entry.slug}: ${entry.outputFile}.`,
    ]);
  }
}

/**
 * @param {{
 *   projectRoot?: string;
 *   repositoryRoot?: string;
 *   changelogs?: typeof CHANGELOGS;
 *   tempParent?: string;
 *   emit?: typeof emitChangelogs;
 *   onTempRoot?: (path: string) => void | Promise<void>;
 * }} [options]
 */
export async function checkChangelogDrift(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? DOC_ROOT);
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const changelogs = options.changelogs ?? CHANGELOGS;
  const emit = options.emit ?? emitChangelogs;
  validateChangelogConfig(changelogs, { projectRoot, repositoryRoot });
  for (const entry of changelogs) await requireReleaseSource(projectRoot, entry);
  for (const entry of changelogs)
    await requireSafeCommittedOutput(projectRoot, repositoryRoot, entry);

  let candidateRoot;
  try {
    candidateRoot = await mkdtemp(
      join(resolve(options.tempParent ?? tmpdir()), "zudo-history-stash-changelog-"),
    );
    await options.onTempRoot?.(candidateRoot);
    const candidates = changelogs.map((entry, index) => ({
      ...entry,
      outputFile: join(
        candidateRoot,
        `${String(index + 1).padStart(2, "0")}-${entry.slug}-CHANGELOG.md`,
      ),
    }));
    const emitted = await emit({
      projectRoot,
      changelogs: candidates,
      logger: { info() {}, warn() {} },
    });
    const expectedWritten = candidates.map((entry) => entry.outputFile);
    if (
      !emitted ||
      !Array.isArray(emitted.written) ||
      emitted.written.join("\0") !== expectedWritten.join("\0")
    ) {
      throw new ChangelogDriftError([
        "Changelog generator did not report the exact three candidate outputs.",
      ]);
    }

    const diagnostics = [];
    for (let index = 0; index < changelogs.length; index += 1) {
      const entry = changelogs[index];
      const candidatePath = candidates[index].outputFile;
      const committedPath = resolve(projectRoot, entry.outputFile);
      const [candidate, committed] = await Promise.all([
        readArtifact(candidatePath, `Generated candidate for ${entry.slug}`),
        readArtifact(committedPath, `Committed changelog for ${entry.slug}`),
      ]);
      if (candidate?.diagnostic) {
        diagnostics.push(candidate.diagnostic);
      } else if (candidate.length === 0) {
        diagnostics.push(`Generated candidate for ${entry.slug} is empty.`);
      }
      if (committed?.diagnostic) {
        diagnostics.push(committed.diagnostic);
      } else if (!candidate?.diagnostic && !candidate.equals(committed)) {
        diagnostics.push(
          `Generated changelog differs for ${entry.slug}: ${relative(repositoryRoot, committedPath)}.`,
        );
      }
    }
    if (diagnostics.length > 0) {
      diagnostics.push(
        "Run pnpm build:doc to regenerate package changelogs from the English MDX sources.",
      );
      throw new ChangelogDriftError(diagnostics);
    }
    return { checked: changelogs.map((entry) => resolve(projectRoot, entry.outputFile)) };
  } finally {
    if (candidateRoot) await rm(candidateRoot, { recursive: true, force: true });
  }
}

function isCli() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCli()) {
  try {
    const result = await checkChangelogDrift();
    console.log(`Changelog drift check passed (${result.checked.length} generated artifacts).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
