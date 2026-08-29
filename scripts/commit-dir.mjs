#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createStashClient } from "@takazudo/zudo-history-stash";
import {
  IDEMPOTENCY_KEY_MAX_CHARS,
  MAX_AUTHOR_BYTES,
  MAX_COMMIT_ENTRIES,
  MAX_COMMIT_INLINE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_META_BYTES,
  canonicalJson,
  isCanonicalBase64,
  isWellFormedString,
  sha256Hex,
  utf8ByteLength,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash-core";

const DEFAULT_BASE_URL = "http://localhost:8787";
const DEFAULT_AUTHOR = "commit-dir";
const DEFAULT_JOB_PREFIX = "commit-dir";
const MAX_JOB_ID_CHARS = IDEMPOTENCY_KEY_MAX_CHARS - 2;
const REPLAY_STATE_VERSION = 1;
const DEFAULT_STATE_DIR_NAME = "zudo-history-stash/commit-dir";

const MIME_TYPES = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
};

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usage() {
  return [
    "Usage: node scripts/commit-dir.mjs <directory> <prefix> <stash> [options]",
    "       node scripts/commit-dir.mjs --directory DIR --prefix PREFIX --stash STASH [options]",
    "",
    "Options:",
    "  --base-url URL                    Stash API base (API_BASE_URL or http://localhost:8787)",
    "  --token TOKEN                    Write token (STASH_WRITE_TOKEN, STASH_ADMIN_TOKEN, or STASH_TOKEN)",
    "  --author NAME                    Commit author (default: commit-dir)",
    "  --message TEXT                   Commit message (default: Sync directory PREFIX)",
    "  --meta JSON                      JSON object attached to every chunk",
    "  --job-id ID                      Stable idempotency prefix for resumable replay",
    "  --expected-last-change-id N      Whole-stash last-change CAS fence",
    "  --prune                          Delete remote live files missing locally",
    "  --change-set                    Create an open change set instead of commits",
    "  --dry-run                        Derive and print the plan without writing",
    "  --help, -h                       Show this help",
  ].join("\n");
}

function flagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${usage()}\nMissing value for ${flag}`);
  return value;
}

function parseSafeInteger(value, flag, { minimum = 0 } = {}) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${flag} must be a non-negative decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} is too large.`);
  }
  return parsed;
}

function parseMeta(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--meta must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--meta must be a JSON object.");
  }
  if (
    Object.prototype.hasOwnProperty.call(parsed, "commitId") ||
    Object.prototype.hasOwnProperty.call(parsed, "changeSetId")
  ) {
    throw new Error("--meta must not set platform-owned commitId or changeSetId.");
  }
  if (utf8ByteLength(JSON.stringify(parsed)) > MAX_META_BYTES) {
    throw new Error(`--meta must be at most ${String(MAX_META_BYTES)} UTF-8 bytes.`);
  }
  return parsed;
}

function validateBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid --base-url; use an HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--base-url must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("--base-url must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("--base-url must not contain a query or fragment.");
  }
  return value.replace(/\/+$/u, "");
}

function validateJobId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("--job-id must not be empty.");
  }
  if (value.trim() !== value) throw new Error("--job-id must not contain whitespace.");
  if (value.length > MAX_JOB_ID_CHARS) {
    throw new Error(`--job-id must be at most ${String(MAX_JOB_ID_CHARS)} characters.`);
  }
  if (!/^[!-~]+$/u.test(value)) {
    throw new Error("--job-id must contain printable ASCII without whitespace.");
  }
  return value;
}

function validatePrefix(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("--prefix must be a non-empty portable path.");
  }
  if (value.includes("\\")) throw new Error("--prefix must use '/' separators.");
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const result = validatePath(normalized);
  if (!result.ok) throw new Error(`Invalid --prefix: ${result.message}`);
  return normalized;
}

function validateStash(value) {
  const result = validateStashName(value);
  if (!result.ok) throw new Error(`Invalid --stash: ${result.message}`);
  return value;
}

function defaultReplayStateDirectory(env) {
  if (env.COMMIT_DIR_STATE_DIR) return resolve(env.COMMIT_DIR_STATE_DIR);
  const xdgRoot = env.XDG_STATE_HOME || env.XDG_CACHE_HOME;
  const root = xdgRoot ? resolve(xdgRoot) : join(homedir() || tmpdir(), ".cache");
  return join(root, DEFAULT_STATE_DIR_NAME);
}

function isPathInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === "" ||
    (!isAbsolute(childRelative) && childRelative !== ".." && !childRelative.startsWith(`..${sep}`))
  );
}

function replayStatePath(options, stateDirectory) {
  const directory = resolve(options.directory);
  const resolvedStateDirectory = resolve(stateDirectory);
  if (isPathInside(directory, resolvedStateDirectory)) {
    throw new Error(
      `Replay state must be outside the walked directory; choose another COMMIT_DIR_STATE_DIR (currently ${resolvedStateDirectory}).`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        baseUrl: options.baseUrl,
        directory,
        jobId: options.jobId,
        prefix: options.prefix,
        stash: options.stash,
      }),
      "utf8",
    )
    .digest("hex");
  return join(resolvedStateDirectory, `${fingerprint}.json`);
}

function replayContext(options, localFiles) {
  return {
    author: options.author,
    baseUrl: options.baseUrl,
    changeSet: options.changeSet,
    directory: resolve(options.directory),
    expectedLastChangeId: options.expectedLastChangeId ?? null,
    localManifest: localFiles
      .map(({ hash, path, relativePath, bytes }) => ({
        hash,
        path,
        relativePath,
        size: bytes.byteLength,
      }))
      .sort((left, right) => compareStrings(left.path, right.path)),
    message: options.message,
    meta: options.meta ?? null,
    prefix: options.prefix,
    prune: options.prune,
    stash: options.stash,
  };
}

/** Parse the standalone command's options without touching the network or filesystem. */
export function readOptions(argv, env = process.env, { createJobId = () => randomUUID() } = {}) {
  let baseUrl = env.API_BASE_URL || env.STASH_URL || DEFAULT_BASE_URL;
  let token = env.STASH_WRITE_TOKEN || env.STASH_ADMIN_TOKEN || env.STASH_TOKEN;
  let directory;
  let prefix;
  let stash;
  let author = DEFAULT_AUTHOR;
  let message;
  let meta;
  let jobId;
  let expectedLastChangeId;
  let prune = false;
  let changeSet = false;
  let dryRun = false;
  let help = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      help = true;
      return {
        author,
        baseUrl,
        changeSet,
        directory,
        dryRun,
        expectedLastChangeId,
        help,
        jobId,
        message,
        meta,
        prefix,
        prune,
        stash,
        token,
      };
    }
    if (argument === "--prune") {
      prune = true;
      continue;
    }
    if (argument === "--change-set") {
      changeSet = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      argument === "--base-url" ||
      argument === "--token" ||
      argument === "--directory" ||
      argument === "-d" ||
      argument === "--prefix" ||
      argument === "-p" ||
      argument === "--stash" ||
      argument === "-s" ||
      argument === "--author" ||
      argument === "--message" ||
      argument === "--meta" ||
      argument === "--job-id" ||
      argument === "--expected-last-change-id"
    ) {
      const value = flagValue(argv, index, argument);
      if (argument === "--base-url") baseUrl = value;
      if (argument === "--token") token = value;
      if (argument === "--directory" || argument === "-d") directory = value;
      if (argument === "--prefix" || argument === "-p") prefix = value;
      if (argument === "--stash" || argument === "-s") stash = value;
      if (argument === "--author") author = value;
      if (argument === "--message") message = value;
      if (argument === "--meta") meta = parseMeta(value);
      if (argument === "--job-id") jobId = value;
      if (argument === "--expected-last-change-id") {
        expectedLastChangeId = parseSafeInteger(value, argument);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--token=")) {
      throw new Error(`${usage()}\nUnknown argument: --token=<redacted>; pass --token TOKEN.`);
    }
    if (argument.startsWith("-")) throw new Error(`${usage()}\nUnknown argument: ${argument}`);
    positional.push(argument);
  }

  if (positional.length > 3) throw new Error(`${usage()}\nToo many positional arguments.`);
  const positionalTargets = ["directory", "prefix", "stash"];
  for (const value of positional) {
    const target = positionalTargets.find(
      (name) => ({ directory, prefix, stash })[name] === undefined,
    );
    if (target === undefined) throw new Error(`${usage()}\nToo many positional arguments.`);
    if (target === "directory") directory = value;
    if (target === "prefix") prefix = value;
    if (target === "stash") stash = value;
  }
  if (!directory || !prefix || !stash) {
    throw new Error(`${usage()}\nDirectory, prefix, and stash are required.`);
  }
  if (typeof author !== "string" || author.length === 0)
    throw new Error("--author must not be empty.");
  if (utf8ByteLength(author) > MAX_AUTHOR_BYTES) {
    throw new Error(`--author must be at most ${String(MAX_AUTHOR_BYTES)} UTF-8 bytes.`);
  }
  if (message === undefined) message = `Sync directory ${prefix}`;
  if (typeof message !== "string" || message.length === 0)
    throw new Error("--message must not be empty.");
  if (utf8ByteLength(message) > MAX_MESSAGE_BYTES) {
    throw new Error(`--message must be at most ${String(MAX_MESSAGE_BYTES)} UTF-8 bytes.`);
  }

  baseUrl = validateBaseUrl(baseUrl);
  prefix = validatePrefix(prefix);
  stash = validateStash(stash);
  if (jobId === undefined) jobId = `${DEFAULT_JOB_PREFIX}-${createJobId()}`;
  jobId = validateJobId(jobId);

  return {
    author,
    baseUrl,
    changeSet,
    directory,
    dryRun,
    expectedLastChangeId,
    help,
    jobId,
    message,
    meta,
    prefix,
    prune,
    stash,
    token,
  };
}

function portableRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Directory walk returned an empty relative path.");
  }
  if (relativePath.includes("\\")) {
    throw new Error(`Directory entry cannot contain a backslash: ${relativePath}`);
  }
  const portable = relativePath.replaceAll("\\", "/");
  if (isAbsolute(portable) || portable.split("/").some((segment) => segment === "")) {
    throw new Error(`Directory entry is not a portable relative path: ${relativePath}`);
  }
  return portable;
}

/** Walk regular files recursively, returning a stable, portable path order. */
export async function walkDirectory(directory, fsImpl = {}) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Directory must be a non-empty filesystem path.");
  }
  const fsOptions = fsImpl ?? {};
  const readdirImpl = fsOptions.readdirImpl || fsOptions.readdir || readdir;
  const statImpl =
    fsOptions.lstatImpl || fsOptions.lstat || fsOptions.statImpl || fsOptions.stat || lstat;
  const root = resolve(directory);
  let rootStat;
  try {
    rootStat = await statImpl(root);
  } catch (error) {
    throw new Error(`Cannot inspect directory ${directory}: ${errorMessage(error)}`);
  }
  if (rootStat.isSymbolicLink?.()) throw new Error(`Refusing symbolic-link root: ${directory}`);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${directory}`);

  const files = [];
  async function visit(current, relativePrefix) {
    let entries;
    try {
      entries = await readdirImpl(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read directory ${current}: ${errorMessage(error)}`);
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        entry.name.length === 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name.includes("\u0000")
      ) {
        throw new Error(`Invalid directory entry below ${current}.`);
      }
      const child = join(current, entry.name);
      const childRelative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(child, childRelative);
      } else if (entry.isFile()) {
        files.push({ absolutePath: child, relativePath: portableRelativePath(childRelative) });
      } else if (entry.isSymbolicLink()) {
        throw new Error(`Refusing symbolic link in directory tree: ${childRelative}`);
      } else {
        throw new Error(`Unsupported non-regular directory entry: ${childRelative}`);
      }
    }
  }
  await visit(root, "");
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return files;
}

export const listDirectoryFiles = walkDirectory;

function contentTypeForPath(path, { text = false } = {}) {
  return (
    MIME_TYPES[extname(path).toLowerCase()] ||
    (text ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}

function decodeUtf8(bytes) {
  try {
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(body);
    if (
      encoded.byteLength !== bytes.byteLength ||
      !encoded.every((value, index) => value === bytes[index])
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

function entryForLocalFile({ path, bytes, expectedVersion }) {
  const body = bytes.byteLength <= MAX_COMMIT_INLINE_BYTES ? decodeUtf8(bytes) : null;
  if (body !== null) {
    return {
      op: "put",
      path,
      expectedVersion,
      body,
      contentType: contentTypeForPath(path, { text: true }),
    };
  }
  return {
    op: "put",
    path,
    expectedVersion,
    representation: "binary",
    contentType: contentTypeForPath(path),
    bytesBase64: Buffer.from(bytes).toString("base64"),
  };
}

async function readDirectoryFiles(directory, prefix, fsImpl = {}) {
  const files = await walkDirectory(directory, fsImpl);
  const fsOptions = fsImpl ?? {};
  const readFileImpl = fsOptions.readFileImpl || fsOptions.readFile || readFile;
  const output = [];
  for (const file of files) {
    const mappedPath = `${prefix}/${file.relativePath}`;
    const pathValidation = validatePath(mappedPath);
    if (!pathValidation.ok)
      throw new Error(`Invalid mapped path ${mappedPath}: ${pathValidation.message}`);
    let bytes;
    try {
      bytes = await readFileImpl(file.absolutePath);
    } catch (error) {
      throw new Error(`Cannot read ${file.relativePath}: ${errorMessage(error)}`);
    }
    if (!(bytes instanceof Uint8Array))
      throw new Error(`Cannot read ${file.relativePath}: expected bytes.`);
    const hash = await sha256Hex(bytes);
    output.push({
      absolutePath: file.absolutePath,
      bytes,
      hash,
      path: mappedPath,
      relativePath: file.relativePath,
    });
  }
  return output;
}

function normalizeRemoteFiles(remoteFiles, prefix) {
  const remoteByPath = new Map();
  for (const remote of remoteFiles) {
    if (!remote || typeof remote.path !== "string")
      throw new Error("Remote file listing contained an invalid path.");
    const validation = validatePath(remote.path);
    if (!validation.ok)
      throw new Error(`Remote file listing contained invalid path ${remote.path}.`);
    if (remote.path !== prefix && !remote.path.startsWith(`${prefix}/`)) continue;
    if (remoteByPath.has(remote.path))
      throw new Error(`Remote file listing repeated ${remote.path}.`);
    const headVersion = remote.headVersion;
    if (!Number.isSafeInteger(headVersion) || headVersion < 1) {
      throw new Error(`Remote file listing contained invalid head version for ${remote.path}.`);
    }
    if (remote.hash !== null && typeof remote.hash !== "string") {
      throw new Error(`Remote file listing contained invalid hash for ${remote.path}.`);
    }
    if (typeof remote.deleted !== "boolean") {
      throw new Error(`Remote file listing contained invalid deletion state for ${remote.path}.`);
    }
    remoteByPath.set(remote.path, remote);
  }
  return remoteByPath;
}

function convertEntry(entry, { changeSet }) {
  if (!changeSet) return entry;
  const { expectedVersion, ...rest } = entry;
  return { ...rest, baseVersion: expectedVersion };
}

/** Derive sorted put/delete entries from local bytes and remote file heads. */
function planFromLocalFiles({
  localFiles,
  prefix,
  remoteFiles = [],
  prune = false,
  changeSet = false,
}) {
  const normalizedPrefix = validatePrefix(prefix);
  const remoteByPath = normalizeRemoteFiles(remoteFiles, normalizedPrefix);
  const localPaths = new Set(localFiles.map((file) => file.path));
  const candidatePaths = new Set(localPaths);
  if (prune) {
    for (const remote of remoteByPath.values()) candidatePaths.add(remote.path);
  }
  const entries = [];

  for (const local of localFiles) {
    const remote = remoteByPath.get(local.path);
    if (remote && !remote.deleted && remote.hash === local.hash) continue;
    const expectedVersion = remote === undefined ? null : remote.headVersion;
    entries.push(
      convertEntry(
        entryForLocalFile({
          bytes: local.bytes,
          expectedVersion,
          path: local.path,
        }),
        { changeSet },
      ),
    );
  }

  if (prune) {
    for (const remote of [...remoteByPath.values()].sort((left, right) =>
      compareStrings(left.path, right.path),
    )) {
      if (!remote.deleted && !localPaths.has(remote.path)) {
        entries.push(
          convertEntry(
            { op: "delete", path: remote.path, expectedVersion: remote.headVersion },
            { changeSet },
          ),
        );
      }
    }
  }
  entries.sort((left, right) => compareStrings(left.path, right.path));
  return {
    candidatePaths: [...candidatePaths].sort(compareStrings),
    entries,
    localFiles,
    prefix: normalizedPrefix,
    remoteFiles: [...remoteByPath.values()].sort((left, right) =>
      compareStrings(left.path, right.path),
    ),
  };
}

export async function planDirectory({
  directory,
  prefix,
  remoteFiles = [],
  prune = false,
  changeSet = false,
  fsImpl,
} = {}) {
  const normalizedPrefix = validatePrefix(prefix);
  const localFiles = await readDirectoryFiles(directory, normalizedPrefix, fsImpl);
  return planFromLocalFiles({
    changeSet,
    localFiles,
    prefix: normalizedPrefix,
    prune,
    remoteFiles,
  });
}

/** Compatibility-friendly array form for callers that only need derived entries. */
export async function deriveEntries(options) {
  return (await planDirectory(options)).entries;
}

/** Read every list page under a prefix before deriving any write. */
export async function listRemoteHeads(files, prefix) {
  const normalizedPrefix = validatePrefix(prefix);
  const remoteFiles = [];
  const seen = new Set();
  const seenCursors = new Set();
  let after;
  for (;;) {
    const options =
      after === undefined
        ? { prefix: normalizedPrefix, includeDeleted: true }
        : { prefix: normalizedPrefix, includeDeleted: true, after };
    let result;
    try {
      result = await files.list(options);
    } catch (error) {
      throw new Error(
        `Listing remote files under ${normalizedPrefix} failed: ${errorMessage(error)}`,
      );
    }
    if (result && result.ok === false)
      throw resultError(`Listing remote files under ${normalizedPrefix}`, result);
    const page = result && result.ok === true ? result.value : result;
    if (!page || !Array.isArray(page.files)) {
      throw new Error(`Listing remote files under ${normalizedPrefix} returned an invalid page.`);
    }
    for (const remote of page.files) {
      if (!remote || typeof remote.path !== "string") {
        throw new Error(`Listing remote files under ${normalizedPrefix} returned an invalid file.`);
      }
      if (seen.has(remote.path)) {
        throw new Error(`Listing remote files under ${normalizedPrefix} repeated ${remote.path}.`);
      }
      seen.add(remote.path);
      remoteFiles.push(remote);
    }
    if (!Object.prototype.hasOwnProperty.call(page, "nextAfter")) {
      throw new Error(
        `Listing remote files under ${normalizedPrefix} returned an invalid pagination cursor.`,
      );
    }
    const nextAfter = page.nextAfter;
    if (nextAfter === null) break;
    if (
      typeof nextAfter !== "string" ||
      nextAfter.length === 0 ||
      nextAfter === after ||
      seenCursors.has(nextAfter)
    ) {
      throw new Error(
        `Listing remote files under ${normalizedPrefix} returned a non-advancing cursor.`,
      );
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
  }
  return remoteFiles;
}

export function chunkEntries(entries, maxEntries = MAX_COMMIT_ENTRIES) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error("Chunk size must be positive.");
  return chunkEntriesByBudget(entries, maxEntries, MAX_COMMIT_INLINE_BYTES);
}

function entryBodyByteLength(entry) {
  if (entry.op !== "put") return 0;
  if (typeof entry.body === "string") return utf8ByteLength(entry.body);
  if (typeof entry.bytesBase64 === "string")
    return Buffer.from(entry.bytesBase64, "base64").byteLength;
  throw new Error(`Entry ${entry.path} has no content body.`);
}

function entryTooLargeError(entry, bytes) {
  return new Error(
    `Entry ${entry.path} is ${String(bytes)} bytes; a single entry cannot exceed ${String(MAX_COMMIT_INLINE_BYTES)} bytes.`,
  );
}

function chunkEntriesByBudget(entries, maxEntries, maxBytes) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new Error("Chunk size must be positive.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Chunk byte budget must be positive.");
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const entryBytes = entryBodyByteLength(entry);
    if (entryBytes > maxBytes) throw entryTooLargeError(entry, entryBytes);
    if (
      current.length > 0 &&
      (current.length >= maxEntries || currentBytes + entryBytes > maxBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function chunkPlans(entries, candidatePaths, maxEntries = MAX_COMMIT_ENTRIES) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Chunk size must be positive.");
  }
  if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) {
    return chunkEntries(entries, maxEntries).map((chunk, index) => ({ entries: chunk, index }));
  }
  const entriesByPath = new Map();
  for (const entry of entries) {
    if (entriesByPath.has(entry.path)) throw new Error(`Entries repeat ${entry.path}.`);
    entriesByPath.set(entry.path, entry);
  }
  const orderedPaths = [...new Set(candidatePaths)].sort(compareStrings);
  const candidateSet = new Set(orderedPaths);
  const plans = [];
  let chunk = [];
  let chunkBytes = 0;
  let slotCount = 0;
  let index = 0;
  const flush = () => {
    if (chunk.length > 0) plans.push({ entries: chunk, index });
    index += 1;
    chunk = [];
    chunkBytes = 0;
    slotCount = 0;
  };
  for (const path of orderedPaths) {
    const entry = entriesByPath.get(path);
    const entryBytes = entry === undefined ? 0 : entryBodyByteLength(entry);
    if (entry !== undefined && entryBytes > MAX_COMMIT_INLINE_BYTES) {
      throw entryTooLargeError(entry, entryBytes);
    }
    if (
      slotCount > 0 &&
      (slotCount >= maxEntries ||
        (entry !== undefined && chunkBytes + entryBytes > MAX_COMMIT_INLINE_BYTES))
    ) {
      flush();
    }
    slotCount += 1;
    if (entry !== undefined) {
      chunk.push(entry);
      chunkBytes += entryBytes;
    }
  }
  if (slotCount > 0) flush();
  const uncategorized = entries.filter((entry) => !candidateSet.has(entry.path));
  for (const uncategorizedChunk of chunkEntriesByBudget(
    uncategorized,
    maxEntries,
    MAX_COMMIT_INLINE_BYTES,
  )) {
    plans.push({ entries: uncategorizedChunk, index });
    index += 1;
  }
  return plans;
}

function loadTokenFromEnvironment(env = process.env) {
  const direct = env.STASH_WRITE_TOKEN || env.STASH_ADMIN_TOKEN || env.STASH_TOKEN;
  if (direct?.trim()) return direct.trim();
  if (typeof process.loadEnvFile === "function") {
    for (const path of [".dev.vars", "workers/stash/.dev.vars"]) {
      try {
        process.loadEnvFile(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const token =
        process.env.STASH_WRITE_TOKEN || process.env.STASH_ADMIN_TOKEN || process.env.STASH_TOKEN;
      if (token?.trim()) return token.trim();
    }
  }
  throw new Error(
    "A write token is required; pass --token or set STASH_WRITE_TOKEN, STASH_ADMIN_TOKEN, or STASH_TOKEN.",
  );
}

export const loadToken = loadTokenFromEnvironment;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resultError(label, result) {
  const code = result?.error?.code || "unknown";
  const message = result?.error?.message || "The API returned an unsuccessful result.";
  return new Error(`${label} failed (${code}): ${message}`);
}

function mutationInput(entries, options) {
  return {
    entries,
    ...(options.author === undefined ? {} : { author: options.author }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.meta === undefined ? {} : { meta: options.meta }),
    ...(options.expectedLastChangeId === undefined
      ? {}
      : { expectedLastChangeId: options.expectedLastChangeId }),
  };
}

function expectedLastChangeIdForChunk(options, precedingEntries) {
  if (options.expectedLastChangeId === undefined || options.changeSet) {
    return options.expectedLastChangeId;
  }
  const expectedLastChangeId = options.expectedLastChangeId + precedingEntries;
  if (!Number.isSafeInteger(expectedLastChangeId)) {
    throw new Error("The whole-stash CAS fence is too large for chunked replay.");
  }
  return expectedLastChangeId;
}

function mutationInputsForChunks(chunkPlansForJob, options) {
  let precedingEntries = 0;
  return chunkPlansForJob.map(({ entries }) => {
    const chunkOptions = {
      ...options,
      expectedLastChangeId: expectedLastChangeIdForChunk(options, precedingEntries),
    };
    const input = mutationInput(entries, chunkOptions);
    precedingEntries += entries.length;
    return input;
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertStoredKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Replay state has an invalid ${label}.`);
  }
}

function assertStoredExpectedVersion(value, changeSet, label) {
  const key = changeSet ? "baseVersion" : "expectedVersion";
  if (!(key in value)) throw new Error(`Replay state ${label} is missing ${key}.`);
  const expected = value[key];
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw new Error(`Replay state ${label} has an invalid ${key}.`);
  }
}

function assertStoredContentType(value, required, label) {
  if (!required && value === undefined) return;
  if (typeof value !== "string" || value.length === 0 || !isWellFormedString(value)) {
    throw new Error(`Replay state ${label} has an invalid content type.`);
  }
}

function assertStoredEntry(entry, { changeSet, label }) {
  if (!isRecord(entry) || typeof entry.op !== "string" || typeof entry.path !== "string") {
    throw new Error(`Replay state ${label} is invalid.`);
  }
  const pathValidation = validatePath(entry.path);
  if (!pathValidation.ok) throw new Error(`Replay state ${label} has an invalid path.`);
  if (entry.op === "put") {
    assertStoredExpectedVersion(entry, changeSet, label);
    if (typeof entry.body === "string") {
      assertStoredKeys(
        entry,
        changeSet
          ? ["op", "path", "baseVersion", "body", "contentType"]
          : ["op", "path", "expectedVersion", "body", "contentType"],
        label,
      );
      if (!isWellFormedString(entry.body) || utf8ByteLength(entry.body) > MAX_COMMIT_INLINE_BYTES) {
        throw new Error(`Replay state ${label} has an invalid text body.`);
      }
      assertStoredContentType(entry.contentType, true, label);
      return;
    }
    assertStoredKeys(
      entry,
      changeSet
        ? ["op", "path", "baseVersion", "representation", "contentType", "bytesBase64"]
        : ["op", "path", "expectedVersion", "representation", "contentType", "bytesBase64"],
      label,
    );
    if (entry.representation !== "binary" || !isCanonicalBase64(entry.bytesBase64)) {
      throw new Error(`Replay state ${label} has an invalid binary body.`);
    }
    assertStoredContentType(entry.contentType, true, label);
    return;
  }
  if (entry.op === "delete") {
    const key = changeSet ? "baseVersion" : "expectedVersion";
    assertStoredKeys(entry, ["op", "path", key], label);
    if (!Number.isSafeInteger(entry[key]) || entry[key] < 1) {
      throw new Error(`Replay state ${label} has an invalid ${key}.`);
    }
    return;
  }
  throw new Error(`Replay state ${label} has an unsupported operation.`);
}

function assertStoredMutationInput(input, { changeSet, expectedLastChangeId, label }) {
  const keys = ["entries", "author", "message", "meta", "expectedLastChangeId"];
  assertStoredKeys(input, keys, label);
  if (!Array.isArray(input.entries) || input.entries.length < 1) {
    throw new Error(`Replay state ${label} has no entries.`);
  }
  if (input.entries.length > MAX_COMMIT_ENTRIES) {
    throw new Error(`Replay state ${label} exceeds the entry limit.`);
  }
  if (typeof input.author !== "string" || !isWellFormedString(input.author)) {
    throw new Error(`Replay state ${label} has an invalid author.`);
  }
  if (utf8ByteLength(input.author) > MAX_AUTHOR_BYTES) {
    throw new Error(`Replay state ${label} has an oversized author.`);
  }
  if (typeof input.message !== "string" || !isWellFormedString(input.message)) {
    throw new Error(`Replay state ${label} has an invalid message.`);
  }
  if (utf8ByteLength(input.message) > MAX_MESSAGE_BYTES) {
    throw new Error(`Replay state ${label} has an oversized message.`);
  }
  if (input.meta !== undefined) {
    if (!isRecord(input.meta)) throw new Error(`Replay state ${label} has invalid metadata.`);
    try {
      if (utf8ByteLength(JSON.stringify(input.meta)) > MAX_META_BYTES) {
        throw new Error(`Replay state ${label} has oversized metadata.`);
      }
    } catch {
      throw new Error(`Replay state ${label} has invalid metadata.`);
    }
  }
  if (
    expectedLastChangeId === undefined
      ? input.expectedLastChangeId !== undefined
      : input.expectedLastChangeId !== expectedLastChangeId
  ) {
    throw new Error(`Replay state ${label} has a mismatched whole-stash CAS fence.`);
  }
  const paths = new Set();
  for (const [index, entry] of input.entries.entries()) {
    assertStoredEntry(entry, { changeSet, label: `${label} entry ${String(index + 1)}` });
    if (paths.has(entry.path)) throw new Error(`Replay state ${label} repeats ${entry.path}.`);
    paths.add(entry.path);
  }
}

function replayStateFor({ chunkInputs, localFiles, chunkPlansForJob, options }) {
  return {
    chunks: chunkPlansForJob.map(({ index }, ordinal) => ({
      index,
      input: chunkInputs[ordinal],
    })),
    context: replayContext(options, localFiles),
    jobId: options.jobId,
    version: REPLAY_STATE_VERSION,
  };
}

function validateReplayState(state, { options, localFiles }) {
  if (!isRecord(state)) throw new Error("Replay state must contain a JSON object.");
  assertStoredKeys(state, ["chunks", "context", "jobId", "version"], "root");
  if (state.version !== REPLAY_STATE_VERSION || state.jobId !== options.jobId) {
    throw new Error("Replay state belongs to a different commit-dir job.");
  }
  const context = replayContext(options, localFiles);
  if (!isRecord(state.context) || canonicalJson(state.context) !== canonicalJson(context)) {
    throw new Error(
      "Replay state does not match the current directory, options, or local file bytes; use a new --job-id.",
    );
  }
  if (!Array.isArray(state.chunks) || state.chunks.length < 1) {
    throw new Error("Replay state has no chunks.");
  }
  const paths = new Set();
  let previousIndex = -1;
  let previousPath = "";
  let precedingEntries = 0;
  for (const [chunkIndex, chunk] of state.chunks.entries()) {
    assertStoredKeys(chunk, ["index", "input"], `chunk ${String(chunkIndex + 1)}`);
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index <= previousIndex) {
      throw new Error("Replay state has non-deterministic chunk indices.");
    }
    previousIndex = chunk.index;
    const key = `${options.jobId}:${String(chunk.index)}`;
    if (key.length > IDEMPOTENCY_KEY_MAX_CHARS) {
      throw new Error(
        `Replay state idempotency key for chunk ${String(chunkIndex + 1)} is too long.`,
      );
    }
    assertStoredMutationInput(chunk.input, {
      changeSet: options.changeSet,
      expectedLastChangeId: expectedLastChangeIdForChunk(options, precedingEntries),
      label: `chunk ${String(chunkIndex + 1)}`,
    });
    ensureChunkBytes(chunk.input.entries, chunkIndex);
    for (const entry of chunk.input.entries) {
      if (paths.has(entry.path)) throw new Error(`Replay state repeats ${entry.path}.`);
      if (previousPath !== "" && compareStrings(previousPath, entry.path) >= 0) {
        throw new Error("Replay state entries are not in deterministic path order.");
      }
      paths.add(entry.path);
      previousPath = entry.path;
    }
    precedingEntries += chunk.input.entries.length;
  }
  return state;
}

async function readReplayState(statePath) {
  let text;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read replay state: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Replay state is not valid JSON; use a new --job-id.");
  }
}

async function writeReplayState(statePath, state) {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    // Preserve insertion order so the SDK serializes a replay request byte-for-byte like the original.
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  } catch (error) {
    throw new Error(`Cannot save replay state: ${errorMessage(error)}`);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary name is unique; a failed cleanup cannot affect the saved plan.
    }
  }
}

function ensureChunkBytes(chunk, index) {
  let bytes = 0;
  for (const entry of chunk) {
    const entryBytes = entryBodyByteLength(entry);
    if (entryBytes > MAX_COMMIT_INLINE_BYTES) throw entryTooLargeError(entry, entryBytes);
    bytes += entryBytes;
  }
  if (bytes > MAX_COMMIT_INLINE_BYTES) {
    throw new Error(
      `Chunk ${String(index + 1)} exceeds the ${String(MAX_COMMIT_INLINE_BYTES)}-byte aggregate body limit.`,
    );
  }
}

/** Build, preview, or submit a directory synchronization job. */
export async function runCommitDir({
  argv = process.argv.slice(2),
  env = process.env,
  createClient = createStashClient,
  client,
  fsImpl,
  stateDir,
  log = console.log,
} = {}) {
  const options = readOptions(argv, env);
  if (options.help) {
    log(usage());
    return { help: true };
  }
  const replayStatePathname = replayStatePath(
    options,
    stateDir === undefined ? defaultReplayStateDirectory(env) : stateDir,
  );
  const token = options.token?.trim() || loadTokenFromEnvironment(env);
  const stashClient = client || createClient({ baseUrl: options.baseUrl, token });
  const files = stashClient.files(options.stash);
  const remoteFiles = await listRemoteHeads(files, options.prefix);
  const savedState = await readReplayState(replayStatePathname);
  let plan;
  let chunkPlansForJob;
  let chunkInputs;
  if (savedState !== null) {
    const localFiles = await readDirectoryFiles(options.directory, options.prefix, fsImpl);
    const validatedState = validateReplayState(savedState, { localFiles, options });
    chunkPlansForJob = validatedState.chunks.map(({ index, input }) => ({
      entries: input.entries,
      index,
    }));
    chunkInputs = validatedState.chunks.map(({ input }) => input);
    plan = {
      candidatePaths: localFiles.map(({ path }) => path).sort(compareStrings),
      entries: chunkInputs.flatMap(({ entries }) => entries),
      localFiles,
      prefix: options.prefix,
      remoteFiles,
    };
    log(`Replaying the recorded ${options.jobId} directory plan.`);
  } else {
    plan = await planDirectory({
      changeSet: options.changeSet,
      directory: options.directory,
      fsImpl,
      prefix: options.prefix,
      prune: options.prune,
      remoteFiles,
    });
    chunkPlansForJob = chunkPlans(plan.entries, plan.candidatePaths);
    chunkInputs = mutationInputsForChunks(chunkPlansForJob, options);
  }
  const chunks = chunkInputs.map(({ entries }) => entries);
  const mode = options.changeSet ? "change set" : "commit";
  log(
    `Prepared ${String(plan.entries.length)} change${plan.entries.length === 1 ? "" : "s"} for ${options.stash}/${plan.prefix} (${mode}, job ${options.jobId}).`,
  );
  if (chunks.length > 1) {
    log(
      `WARNING: ${String(plan.entries.length)} files require ${String(chunks.length)} chunks; each chunk is separately atomic, and the whole directory is not one transaction.`,
    );
  }
  for (const entry of plan.entries) {
    log(
      `  ${entry.op} ${entry.path}${entry.representation === "binary" ? " (binary)" : entry.contentType ? ` (${entry.contentType})` : ""}`,
    );
  }
  if (options.dryRun) {
    log("Dry run: no writes performed.");
    return { chunks, options, plan, results: [], wrote: false };
  }
  if (chunks.length === 0) {
    log("No changes; no write performed.");
    return { chunks, options, plan, results: [], wrote: false };
  }

  if (options.expectedLastChangeId !== undefined && chunks.length > 1) {
    log(
      options.changeSet
        ? "Whole-stash CAS is checked against the original head for each change-set chunk; chunks remain separately atomic."
        : "Whole-stash CAS advances by the number of entries in earlier commit chunks; chunks remain separately atomic, and competing writes still fail the next fence.",
    );
  }
  for (const [index, chunk] of chunks.entries()) ensureChunkBytes(chunk, index);
  const idempotencyKeys = chunkPlansForJob.map(({ index }) => `${options.jobId}:${String(index)}`);
  for (const [index, key] of idempotencyKeys.entries()) {
    if (key.length > IDEMPOTENCY_KEY_MAX_CHARS) {
      throw new Error(`Generated idempotency key for chunk ${String(index + 1)} is too long.`);
    }
  }
  if (savedState === null) {
    const replayState = replayStateFor({
      chunkInputs,
      chunkPlansForJob,
      localFiles: plan.localFiles,
      options,
    });
    validateReplayState(replayState, { localFiles: plan.localFiles, options });
    await writeReplayState(replayStatePathname, replayState);
  }
  const mutations = options.changeSet
    ? stashClient.changeSets(options.stash)
    : stashClient.commits(options.stash);
  const results = [];
  for (const [ordinal, chunk] of chunks.entries()) {
    const key = idempotencyKeys[ordinal];
    const input = chunkInputs[ordinal];
    let result;
    try {
      result = await mutations.create(input, { idempotencyKey: key });
    } catch (error) {
      throw new Error(
        `Writing ${mode} chunk ${String(ordinal + 1)}/${String(chunks.length)} failed: ${errorMessage(error)}`,
      );
    }
    if (!result?.ok) {
      throw resultError(
        `Writing ${mode} chunk ${String(ordinal + 1)}/${String(chunks.length)}`,
        result,
      );
    }
    const replayed = result.replayed === true;
    results.push(result);
    log(
      `${replayed ? "Replayed (Idempotent-Replayed)" : "Created"} ${mode} chunk ${String(ordinal + 1)}/${String(chunks.length)} (${String(chunk.length)} entr${chunk.length === 1 ? "y" : "ies"}).`,
    );
  }
  return { chunks, options, plan, results, wrote: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCommitDir();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
