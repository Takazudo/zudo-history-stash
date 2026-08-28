#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_STASH_CONFIG = resolve(REPOSITORY_ROOT, "workers/stash/wrangler.toml");
const DEFAULT_VIEWER_CONFIG = resolve(REPOSITORY_ROOT, "workers/viewer/wrangler.toml");

const SUPPORTED_TOP_LEVEL_KEYS = new Set([
  "name",
  "main",
  "compatibility_date",
  "workers_dev",
  "preview_urls",
  "triggers",
  "observability",
  "assets",
  "routes",
  "services",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "migrations",
  "vars",
  "secrets",
  "ratelimits",
  "env",
]);
const SUPPORTED_PREVIEW_KEYS = new Set(
  [...SUPPORTED_TOP_LEVEL_KEYS].filter((key) => key !== "env"),
);
const INHERITED_TOP_LEVEL_KEYS = ["main", "compatibility_date", "observability", "assets"];

export const PREVIEW_RATE_LIMIT_BASE = 2_000_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a TOML table`);
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of TOML tables`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function normalizePrNumber(value) {
  const pr = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !Number.isSafeInteger(PREVIEW_RATE_LIMIT_BASE + pr * 10)
  ) {
    throw new Error("--pr must be a positive safe integer");
  }
  return pr;
}

export function normalizeViewerOrigin(value) {
  const input = assertString(value, "--viewer-origin");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("--viewer-origin must be an absolute HTTP(S) origin");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("--viewer-origin must be an absolute HTTP(S) origin without a path");
  }
  return url.origin;
}

function toTomlPath(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function rebasePath(path, sourceConfigPath, outputConfigPath) {
  const sourceValue = assertString(path, "Wrangler path");
  const absolute = isAbsolute(sourceValue)
    ? resolve(sourceValue)
    : resolve(dirname(sourceConfigPath), sourceValue);
  const rebased = relative(dirname(outputConfigPath), absolute);
  if (rebased === "") return ".";
  const portable = toTomlPath(rebased);
  return portable.startsWith(".") ? portable : `./${portable}`;
}

function rebaseMigrationsPattern(pattern, sourceDirectory, rebasedDirectory) {
  const normalizedPattern = toTomlPath(assertString(pattern, "D1 migrations_pattern"));
  const normalizedSource = toTomlPath(sourceDirectory).replace(/^\.\//, "").replace(/\/$/, "");
  const comparablePattern = normalizedPattern.replace(/^\.\//, "");
  const prefix = `${normalizedSource}/`;
  if (!comparablePattern.startsWith(prefix)) {
    throw new Error("D1 migrations_pattern must remain inside migrations_dir");
  }
  return `${rebasedDirectory.replace(/\/$/, "")}/${comparablePattern.slice(prefix.length)}`;
}

function assertSupportedKeys(source, supportedKeys, label) {
  for (const key of Object.keys(source)) {
    if (!supportedKeys.has(key)) {
      const kind = isRecord(source[key]) || Array.isArray(source[key]) ? "table" : "key";
      throw new Error(`${label}: unsupported ${kind} "${key}"`);
    }
  }
}

function selectBinding(bindings, bindingName, label) {
  const matches = assertArray(bindings, label).filter(
    (binding) => assertRecord(binding, `${label} entry`).binding === bindingName,
  );
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one ${bindingName} binding`);
  }
  return matches[0];
}

function flattenPreviewEnvironment(source, sourceConfigPath) {
  assertSupportedKeys(source, SUPPORTED_TOP_LEVEL_KEYS, `${sourceConfigPath}: top level`);
  const env = assertRecord(source.env, `${sourceConfigPath}: env`);
  const sourcePreview = assertRecord(env.preview, `${sourceConfigPath}: env.preview`);
  assertSupportedKeys(sourcePreview, SUPPORTED_PREVIEW_KEYS, `${sourceConfigPath}: env.preview`);
  const preview = clone(sourcePreview);

  for (const key of INHERITED_TOP_LEVEL_KEYS) {
    if (source[key] !== undefined) preview[key] = clone(source[key]);
  }

  delete preview.env;
  delete preview.routes;
  preview.workers_dev = true;
  const triggers = preview.triggers === undefined ? {} : assertRecord(preview.triggers, "triggers");
  preview.triggers = { ...triggers, crons: [] };
  return preview;
}

function rebaseConfigPaths(config, sourceConfigPath, outputConfigPath) {
  config.main = rebasePath(config.main, sourceConfigPath, outputConfigPath);

  if (config.assets !== undefined) {
    const assets = assertRecord(config.assets, "assets");
    config.assets = {
      ...assets,
      directory: rebasePath(assets.directory, sourceConfigPath, outputConfigPath),
    };
  }

  if (config.d1_databases !== undefined) {
    config.d1_databases = assertArray(config.d1_databases, "d1_databases").map((entry) => {
      const database = { ...assertRecord(entry, "d1_databases entry") };
      const sourceDirectory =
        database.migrations_dir === undefined
          ? "./migrations"
          : assertString(database.migrations_dir, "D1 migrations_dir");
      const rebasedDirectory = rebasePath(sourceDirectory, sourceConfigPath, outputConfigPath);
      database.migrations_dir = rebasedDirectory;
      if (database.migrations_pattern !== undefined) {
        database.migrations_pattern = rebaseMigrationsPattern(
          database.migrations_pattern,
          sourceDirectory,
          rebasedDirectory,
        );
      }
      return database;
    });
  }
}

function applyStashPreview(config, { pr, d1Id, viewerOrigin }) {
  config.name = `zudo-history-stash-pr-${pr}`;

  const database = selectBinding(config.d1_databases, "DB", "d1_databases");
  database.database_name = `zudo-history-stash-pr-${pr}`;
  database.database_id = assertString(d1Id, "--d1-id");

  const bucket = selectBinding(config.r2_buckets, "BLOBS", "r2_buckets");
  bucket.bucket_name = `zudo-history-stash-blobs-pr-${pr}`;

  const vars = config.vars === undefined ? {} : assertRecord(config.vars, "vars");
  config.vars = { ...vars, ALLOWED_ORIGINS: viewerOrigin };

  const ratelimits = assertArray(config.ratelimits, "ratelimits");
  if (ratelimits.length > 10) {
    throw new Error("ratelimits cannot exceed the 10-ID per-PR preview allocation");
  }
  const lastNamespaceId = PREVIEW_RATE_LIMIT_BASE + pr * 10 + Math.max(0, ratelimits.length - 1);
  if (!Number.isSafeInteger(lastNamespaceId) || lastNamespaceId < 1) {
    throw new Error("--pr produces an unsafe rate-limit namespace allocation");
  }
  config.ratelimits = ratelimits.map((entry, index) => ({
    ...assertRecord(entry, "ratelimits entry"),
    namespace_id: String(PREVIEW_RATE_LIMIT_BASE + pr * 10 + index),
  }));
}

function applyViewerPreview(config, { pr }) {
  config.name = `zudo-history-stash-viewer-pr-${pr}`;
  const service = selectBinding(config.services, "STASH", "services");
  service.service = `zudo-history-stash-pr-${pr}`;
}

export function createPreviewConfig({
  source,
  sourceConfigPath,
  outputConfigPath,
  kind,
  pr,
  d1Id,
  viewerOrigin,
}) {
  const normalizedPr = normalizePrNumber(pr);
  const normalizedOrigin = normalizeViewerOrigin(viewerOrigin);
  const parsed = typeof source === "string" ? parse(source) : clone(source);
  const config = flattenPreviewEnvironment(
    assertRecord(parsed, `${sourceConfigPath}: document`),
    sourceConfigPath,
  );
  rebaseConfigPaths(config, sourceConfigPath, outputConfigPath);

  if (kind === "stash") {
    applyStashPreview(config, {
      pr: normalizedPr,
      d1Id,
      viewerOrigin: normalizedOrigin,
    });
  } else if (kind === "viewer") {
    applyViewerPreview(config, { pr: normalizedPr });
  } else {
    throw new Error(`Unknown preview config kind: ${kind}`);
  }

  return config;
}

export function serializePreviewConfig(config) {
  return `# Generated by scripts/preview-config.mjs. Do not edit.\n${stringify(config).trimEnd()}\n`;
}

async function createOne({ sourceConfigPath, outputConfigPath, kind, pr, d1Id, viewerOrigin }) {
  const source = await readFile(sourceConfigPath, "utf8");
  return createPreviewConfig({
    source,
    sourceConfigPath,
    outputConfigPath,
    kind,
    pr,
    d1Id,
    viewerOrigin,
  });
}

export async function generatePreviewConfigs({
  pr,
  d1Id,
  viewerOrigin,
  outDir,
  stashConfigPath = DEFAULT_STASH_CONFIG,
  viewerConfigPath = DEFAULT_VIEWER_CONFIG,
}) {
  const normalizedPr = normalizePrNumber(pr);
  const normalizedOrigin = normalizeViewerOrigin(viewerOrigin);
  const resolvedOutDir =
    outDir === undefined
      ? resolve(REPOSITORY_ROOT, `.wrangler/previews/pr-${normalizedPr}`)
      : resolve(outDir);
  const stashOutputPath = resolve(resolvedOutDir, "stash.toml");
  const viewerOutputPath = resolve(resolvedOutDir, "viewer.toml");
  await mkdir(resolvedOutDir, { recursive: true });

  const [stash, viewer] = await Promise.all([
    createOne({
      sourceConfigPath: resolve(stashConfigPath),
      outputConfigPath: stashOutputPath,
      kind: "stash",
      pr: normalizedPr,
      d1Id,
      viewerOrigin: normalizedOrigin,
    }),
    createOne({
      sourceConfigPath: resolve(viewerConfigPath),
      outputConfigPath: viewerOutputPath,
      kind: "viewer",
      pr: normalizedPr,
      d1Id,
      viewerOrigin: normalizedOrigin,
    }),
  ]);
  await Promise.all([
    writeFile(stashOutputPath, serializePreviewConfig(stash), "utf8"),
    writeFile(viewerOutputPath, serializePreviewConfig(viewer), "utf8"),
  ]);

  return {
    pr: normalizedPr,
    outDir: resolvedOutDir,
    stashConfigPath: stashOutputPath,
    viewerConfigPath: viewerOutputPath,
    stash,
    viewer,
  };
}

function usage() {
  return [
    "Usage: pnpm preview:config --pr <number> --d1-id <id> --viewer-origin <origin> [--out <dir>]",
    "",
    "Writes stash.toml and viewer.toml under --out (default: .wrangler/previews/pr-<number>).",
  ].join("\n");
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--pr", "--d1-id", "--viewer-origin", "--out"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (values[argument] !== undefined) throw new Error(`${argument} may be provided only once`);
    values[argument] = value;
    index += 1;
  }
  for (const required of ["--pr", "--d1-id", "--viewer-origin"]) {
    if (values[required] === undefined) throw new Error(`${required} is required`);
  }
  return {
    pr: values["--pr"],
    d1Id: values["--d1-id"],
    viewerOrigin: values["--viewer-origin"],
    outDir: values["--out"],
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await generatePreviewConfigs(options);
  console.log(
    JSON.stringify(
      {
        pr: result.pr,
        stashConfig: result.stashConfigPath,
        viewerConfig: result.viewerConfigPath,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
