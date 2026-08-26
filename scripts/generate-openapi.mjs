import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import prettier from "prettier";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedPath = join(repoRoot, "docs/openapi.json");

function parseArguments(args) {
  let check = false;
  let outputPath;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--output") {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error("--output requires a path");
      outputPath = resolve(repoRoot, next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (check && outputPath) throw new Error("--check cannot be combined with --output");
  return { check, outputPath: outputPath ?? committedPath };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

async function buildCore() {
  const result = await execFileAsync(
    "pnpm",
    ["--filter", "@takazudo/zudo-history-stash-core", "build"],
    { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function serializeDocument() {
  const { buildOpenApiDocument } = await import("@takazudo/zudo-history-stash-core/openapi");
  const config = (await prettier.resolveConfig(committedPath)) ?? {};
  return prettier.format(JSON.stringify(sortKeys(buildOpenApiDocument()), null, 2), {
    ...config,
    parser: "json",
  });
}

async function writeDocument(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, "utf8");
}

async function main() {
  const { check, outputPath } = parseArguments(process.argv.slice(2));
  await buildCore();
  const contents = await serializeDocument();

  if (!check) {
    await writeDocument(outputPath, contents);
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zudo-history-stash-openapi-"));
  const temporaryPath = join(temporaryDirectory, "openapi.json");
  try {
    await writeDocument(temporaryPath, contents);
    const [committed, generated] = await Promise.all([
      readFile(committedPath),
      readFile(temporaryPath),
    ]);
    if (!committed.equals(generated)) {
      throw new Error("docs/openapi.json is out of date; run pnpm openapi:generate");
    }
    process.stdout.write("docs/openapi.json is up to date.\n");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
