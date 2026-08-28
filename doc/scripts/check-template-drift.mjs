#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readJson } from "./tooling-utils.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export function generatorArguments(presetPath) {
  return ["doc", "--preset", presetPath, "--no-install", "--no-git"];
}

export async function resolveCreateZudoDocBin() {
  let current = dirname(require.resolve("create-zudo-doc"));
  while (true) {
    const packagePath = join(current, "package.json");
    try {
      const manifest = await readJson(packagePath);
      if (manifest.name === "create-zudo-doc") {
        const bin =
          typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["create-zudo-doc"];
        if (typeof bin !== "string") throw new Error("create-zudo-doc has no CLI bin");
        return { binPath: resolve(current, bin), version: manifest.version };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("could not locate installed create-zudo-doc package");
    current = parent;
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectTree(root) {
  const entries = new Map();
  const directories = new Set();
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, item.name);
      const relativePath = relative(root, fullPath).split(sep).join("/");
      if (item.isDirectory()) {
        directories.add(relativePath);
        await walk(fullPath);
      } else if (item.isSymbolicLink()) {
        entries.set(relativePath, { type: "symlink", value: await readlink(fullPath) });
      } else if (item.isFile()) {
        entries.set(relativePath, { type: "file", value: await readFile(fullPath) });
      } else {
        throw new Error(`unsupported generated entry type: ${relativePath}`);
      }
    }
  }
  await walk(root);
  return { entries, directories };
}

export function parseTemplateAllowlist(source, emittedEntries, emittedDirectories) {
  const allowlist = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf(" :: ");
    if (separator === -1) {
      throw new Error(`allowlist line ${index + 1} needs an exact path and nearby reason`);
    }
    const path = line.slice(0, separator).trim();
    const reason = line.slice(separator + 4).trim();
    if (reason === "") throw new Error(`allowlist line ${index + 1} has no reason`);
    if (
      path === "" ||
      isAbsolute(path) ||
      path.includes("\\") ||
      /[*?{}]/.test(path) ||
      path.split("/").includes("..") ||
      path.endsWith("/")
    ) {
      throw new Error(`allowlist line ${index + 1} is not an exact safe file path: ${path}`);
    }
    if (emittedDirectories.has(path)) {
      throw new Error(`allowlist entry must name a file, not directory: ${path}`);
    }
    if (!emittedEntries.has(path)) throw new Error(`stale allowlist entry is not emitted: ${path}`);
    if (allowlist.has(path)) throw new Error(`duplicate allowlist entry: ${path}`);
    allowlist.set(path, reason);
  }
  return allowlist;
}

async function liveEntry(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) return { type: "symlink", value: await readlink(path) };
  if (info.isFile()) return { type: "file", value: await readFile(path) };
  return { type: "other", value: null };
}

function entriesEqual(left, right) {
  if (left?.type !== right?.type) return false;
  if (left?.type === "file") return left.value.equals(right.value);
  return left?.value === right?.value;
}

export async function compareGeneratedTree(generatedRoot, liveRoot, allowlistPath) {
  const { entries, directories } = await collectTree(generatedRoot);
  const allowlist = parseTemplateAllowlist(
    await readFile(allowlistPath, "utf8"),
    entries,
    directories,
  );
  const failures = [];
  for (const [path, generated] of entries) {
    const live = await liveEntry(resolve(liveRoot, path));
    const same = entriesEqual(generated, live);
    if (allowlist.has(path)) {
      if (same) failures.push(`${path}: allowlist entry is stale because bytes now match`);
      continue;
    }
    if (live === null) failures.push(`${path}: generator-owned file is missing`);
    else if (live.type !== generated.type)
      failures.push(`${path}: generated/live entry types differ`);
    else if (!same) failures.push(`${path}: generator-owned bytes differ`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return { compared: entries.size - allowlist.size, allowlisted: allowlist.size };
}

export async function checkTemplateDrift(repositoryRoot, options = {}) {
  const docRoot = resolve(repositoryRoot, "doc");
  const presetPath = resolve(docRoot, "setup-preset.json");
  const allowlistPath = resolve(docRoot, ".template-drift-allowlist");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "zhs-template-drift-"));
  try {
    const { binPath, version } = await resolveCreateZudoDocBin();
    const args = generatorArguments(presetPath);
    if (!args.includes("--no-install") || !args.includes("--no-git")) {
      throw new Error("generator invocation must disable install and Git initialization");
    }
    const runGenerator =
      options.runGenerator ??
      (async () => {
        await execFileAsync(process.execPath, [binPath, ...args], {
          cwd: temporaryRoot,
          env: { ...process.env, CI: "1", NO_COLOR: "1" },
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        });
      });
    await runGenerator({ binPath, args, cwd: temporaryRoot });
    const generatedRoot = resolve(temporaryRoot, "doc");
    if (!(await exists(generatedRoot))) throw new Error("generator did not emit the doc project");
    return { version, ...(await compareGeneratedTree(generatedRoot, docRoot, allowlistPath)) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  checkTemplateDrift(resolve(scriptDir, "../.."))
    .then(({ version, compared, allowlisted }) => {
      console.log(
        `Template drift OK (create-zudo-doc ${version}; ${compared} managed, ${allowlisted} intentional differences)`,
      );
    })
    .catch((error) => {
      console.error(`Template drift failed:\n${error.message}`);
      process.exitCode = 1;
    });
}
