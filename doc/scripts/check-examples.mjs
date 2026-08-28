#!/usr/bin/env node

import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ID_PATTERN = /^(?:consumer|ops|reference)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKER_PATTERN = /^\s*\{\/\*\s*zhs-example:\s*([^\s]+)\s*\*\/\}\s*$/;
const TYPESCRIPT_FENCE_PATTERN = /^\s*(`{3,}|~{3,})(ts|typescript|tsx)(?:\s+.*)?$/i;
const NESTED_TYPESCRIPT_FENCE_PATTERN =
  /^\s*(?:>\s*|(?:[-+*]|\d+[.)])\s+)+(`{3,}|~{3,})(ts|typescript|tsx)(?:\s+.*)?$/i;
const ANY_FENCE_PATTERN = /^\s*(`{3,}|~{3,})([^\s]*)?.*$/;
const BYPASS_PATTERN =
  /^\s*<(?:pre|code)\b|^\s*<(?:SourceCode|CodeSource|CodeInclude|CodeSnippet|SourceInclude|SnippetInclude|[A-Z][A-Za-z]*(?:Include|Snippet|Source)[A-Za-z]*)\b/;
const INDENTED_CODE_PATTERN =
  /^ {4}(?:import|export|const|let|var|function|class|interface|type)\b/;

export class ExampleCheckError extends Error {
  constructor(diagnostics) {
    super(`Example check failed:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
    this.name = "ExampleCheckError";
    this.diagnostics = diagnostics;
  }
}

function normalizeBytes(value) {
  return value.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

function sortedManifest(snippets) {
  return {
    schemaVersion: 1,
    snippets: Object.fromEntries(
      [...snippets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, source]) => [id, { source }]),
    ),
  };
}

function serializedManifest(snippets) {
  return `${JSON.stringify(sortedManifest(snippets), null, 2)}\n`;
}

function addDiagnostic(diagnostics, message) {
  diagnostics.add(message);
}

async function collectFiles(root, predicate, { pruneDirectory = () => false } = {}) {
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!pruneDirectory(relative(root, path))) await walk(path);
      } else if (entry.isFile() && predicate(path)) result.push(path);
    }
  }
  await walk(root);
  return result.sort();
}

async function collectExampleSources(root) {
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ([".ts", ".tsx"].includes(extname(entry.name))) {
        result.push({ entry, path, relativePath: relative(root, path) });
      }
    }
  }
  await walk(root);
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isGeneratedClaudePath(path) {
  return path
    .split(/[\\/]/)
    .some((segment) => segment.toLocaleLowerCase("en-US").startsWith("claude"));
}

function sourceFor(id, language) {
  return `${id}.${language === "tsx" ? "tsx" : "ts"}`;
}

function parseMdx(path, body, locale, diagnostics) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const uses = [];
  const localeIds = new Set();
  let openFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const anyFence = ANY_FENCE_PATTERN.exec(line);
    if (openFence !== null) {
      if (
        anyFence !== null &&
        anyFence[1][0] === openFence.marker[0] &&
        anyFence[1].length >= openFence.marker.length &&
        (anyFence[2] ?? "") === ""
      ) {
        const code = normalizeBytes(lines.slice(openFence.start, index).join("\n"));
        uses.push({ ...openFence, code });
        openFence = null;
      }
      continue;
    }

    if (BYPASS_PATTERN.test(line)) {
      addDiagnostic(
        diagnostics,
        `${locale}: unsupported code/include markup at ${path}:${index + 1}`,
      );
    }
    if (/^\s*import\s+.*(?:\.tsx?\b|\?raw["'])/.test(line)) {
      addDiagnostic(
        diagnostics,
        `${locale}: TypeScript source imports are not a supported example include at ${path}:${index + 1}`,
      );
    }
    if (/^\s*<!--\s*zhs-example:/.test(line)) {
      addDiagnostic(
        diagnostics,
        `${locale}: HTML example markers are not MDX-compatible at ${path}:${index + 1}; use {/* zhs-example: id */}`,
      );
    }
    if (INDENTED_CODE_PATTERN.test(line)) {
      addDiagnostic(
        diagnostics,
        `${locale}: indented TypeScript-like code is not mapped at ${path}:${index + 1}`,
      );
    }

    const typedFence = TYPESCRIPT_FENCE_PATTERN.exec(line);
    if (typedFence !== null) {
      let previousIndex = index - 1;
      while (previousIndex >= 0 && lines[previousIndex].trim() === "") previousIndex -= 1;
      const marker = MARKER_PATTERN.exec(lines[previousIndex] ?? "");
      if (marker === null) {
        addDiagnostic(
          diagnostics,
          `${locale}: TypeScript fence is missing an adjacent zhs-example marker at ${path}:${index + 1}`,
        );
        openFence = {
          id: `<unmapped-${index + 1}>`,
          language: typedFence[2].toLowerCase(),
          marker: typedFence[1],
          path,
          start: index + 1,
        };
        continue;
      }
      const id = marker[1];
      if (!ID_PATTERN.test(id)) {
        addDiagnostic(
          diagnostics,
          `${locale}: invalid example id ${id} at ${path}:${previousIndex + 1}`,
        );
      }
      if (localeIds.has(id)) {
        addDiagnostic(diagnostics, `${locale}: duplicate example id ${id}`);
      }
      localeIds.add(id);
      openFence = {
        id,
        language: typedFence[2].toLowerCase(),
        marker: typedFence[1],
        path,
        start: index + 1,
      };
      continue;
    }

    if (NESTED_TYPESCRIPT_FENCE_PATTERN.test(line)) {
      addDiagnostic(
        diagnostics,
        `${locale}: nested TypeScript fences are not supported at ${path}:${index + 1}; use a top-level mapped fence`,
      );
    }

    const marker = MARKER_PATTERN.exec(line);
    if (marker !== null) {
      let nextIndex = index + 1;
      while (nextIndex < lines.length && lines[nextIndex].trim() === "") nextIndex += 1;
      if (TYPESCRIPT_FENCE_PATTERN.exec(lines[nextIndex] ?? "") === null) {
        addDiagnostic(
          diagnostics,
          `${locale}: example marker ${marker[1]} is not adjacent to a TypeScript fence at ${path}:${index + 1}`,
        );
      }
    }

    if (anyFence !== null) openFence = { marker: anyFence[1], start: index + 1, ignored: true };
  }

  if (openFence !== null) {
    addDiagnostic(diagnostics, `${locale}: unterminated code fence at ${path}:${openFence.start}`);
  }
  return uses.filter((use) => !use.ignored && !use.id.startsWith("<unmapped-"));
}

async function readManifest(manifestPath) {
  let source;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`example manifest is unavailable at ${manifestPath}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`example manifest is malformed at ${manifestPath}: ${error.message}`);
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.snippets === null ||
    typeof manifest.snippets !== "object" ||
    Array.isArray(manifest.snippets)
  ) {
    throw new Error("example manifest must use schemaVersion 1 with a snippets object");
  }
  if (
    Object.keys(manifest).length !== 2 ||
    !Object.hasOwn(manifest, "schemaVersion") ||
    !Object.hasOwn(manifest, "snippets")
  ) {
    throw new Error("example manifest has unknown root fields");
  }
  return { manifest, source };
}

async function validateTsconfig(repositoryRoot, tsconfigPath, examplePaths, diagnostics) {
  const configResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configResult.error !== undefined) {
    addDiagnostic(
      diagnostics,
      `tsconfig: ${ts.flattenDiagnosticMessageText(configResult.error.messageText, " ")}`,
    );
    return;
  }
  const parsed = ts.parseJsonConfigFileContent(configResult.config, ts.sys, dirname(tsconfigPath));
  for (const error of parsed.errors) {
    addDiagnostic(
      diagnostics,
      `tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
    );
  }
  if (parsed.options.skipLibCheck !== false) {
    addDiagnostic(diagnostics, "tsconfig: skipLibCheck must be false");
  }
  const included = new Set(parsed.fileNames.map((path) => resolve(path)));
  for (const path of examplePaths) {
    if (!included.has(resolve(path))) {
      addDiagnostic(diagnostics, `tsconfig: example source is not included: ${basename(path)}`);
    }
  }
  const requiredPaths = new Map([
    ["@takazudo/zudo-history-stash", "packages/client/dist/index.d.ts"],
    ["@takazudo/zudo-history-stash/testing", "packages/client/dist/testing/index.d.ts"],
    ["@takazudo/zudo-history-stash-core", "packages/core/dist/index.d.ts"],
    ["@takazudo/zudo-history-stash-core/openapi", "packages/core/dist/openapi/index.d.ts"],
    ["@takazudo/zudo-history-stash-ui", "packages/ui/dist/index.d.ts"],
  ]);
  for (const [specifier, suffix] of requiredPaths) {
    const targets = parsed.options.paths?.[specifier];
    const resolvedTarget =
      Array.isArray(targets) && targets.length === 1
        ? resolve(parsed.options.baseUrl ?? dirname(tsconfigPath), targets[0])
        : null;
    if (resolvedTarget === null || resolvedTarget !== resolve(repositoryRoot, suffix)) {
      addDiagnostic(diagnostics, `tsconfig: ${specifier} must resolve only to ${suffix}`);
    }
  }
  for (const targets of Object.values(parsed.options.paths ?? {})) {
    if (
      targets.some((target) => /(^|\/)packages\/[^/]+\/src\//.test(target.replaceAll("\\", "/")))
    ) {
      addDiagnostic(diagnostics, "tsconfig: package paths must not resolve to package source");
    }
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  for (const error of ts.getPreEmitDiagnostics(program)) {
    const location =
      error.file === undefined || error.start === undefined
        ? ""
        : `${relative(dirname(tsconfigPath), error.file.fileName)}:${error.file.getLineAndCharacterOfPosition(error.start).line + 1}: `;
    addDiagnostic(
      diagnostics,
      `typecheck: ${location}${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
    );
  }
}

function defaultContentRoots(repositoryRoot) {
  return {
    en: resolve(repositoryRoot, "doc/src/content/docs"),
    ja: resolve(repositoryRoot, "doc/src/content/docs-ja"),
  };
}

export async function checkExamples({
  repositoryRoot,
  contentRoots = defaultContentRoots(repositoryRoot),
  locales = Object.keys(contentRoots),
  examplesRoot = resolve(repositoryRoot, "doc/examples-check"),
  manifestPath = resolve(examplesRoot, "manifest.json"),
  tsconfigPath = resolve(examplesRoot, "tsconfig.json"),
  write = false,
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("repositoryRoot is required");
  }
  const diagnostics = new Set();
  const uses = [];
  for (const locale of locales) {
    const localeIds = new Set();
    const root = contentRoots[locale];
    if (typeof root !== "string") {
      addDiagnostic(diagnostics, `${locale}: content root is not configured`);
      continue;
    }
    let files;
    try {
      files = await collectFiles(root, (path) => path.endsWith(".mdx"), {
        pruneDirectory: isGeneratedClaudePath,
      });
    } catch (error) {
      addDiagnostic(diagnostics, `${locale}: content root is unavailable: ${error.message}`);
      continue;
    }
    for (const path of files) {
      const fileUses = parseMdx(path, await readFile(path, "utf8"), locale, diagnostics);
      for (const use of fileUses) {
        if (localeIds.has(use.id))
          addDiagnostic(diagnostics, `${locale}: duplicate example id ${use.id}`);
        localeIds.add(use.id);
        uses.push(use);
      }
    }
  }

  const derived = new Map();
  for (const use of uses) {
    const source = sourceFor(use.id, use.language);
    const previous = derived.get(use.id);
    if (previous !== undefined && previous !== source) {
      addDiagnostic(diagnostics, `example id ${use.id} maps to both ${previous} and ${source}`);
    }
    derived.set(use.id, source);
  }
  if (derived.size === 0) addDiagnostic(diagnostics, "examples: discovered zero mapped examples");

  let manifest;
  let manifestSource;
  if (write) {
    manifest = sortedManifest(derived);
    manifestSource = serializedManifest(derived);
  } else {
    try {
      ({ manifest, source: manifestSource } = await readManifest(manifestPath));
    } catch (error) {
      addDiagnostic(diagnostics, error.message);
      manifest = { snippets: {} };
      manifestSource = "";
    }
  }
  const manifestEntries = new Map();
  for (const [id, entry] of Object.entries(manifest.snippets)) {
    if (!ID_PATTERN.test(id)) addDiagnostic(diagnostics, `manifest: invalid example id ${id}`);
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.source !== "string"
    ) {
      addDiagnostic(diagnostics, `manifest: ${id} must contain one source string`);
      continue;
    }
    if (Object.keys(entry).length !== 1)
      addDiagnostic(diagnostics, `manifest: ${id} has unknown fields`);
    const source = entry.source;
    if (
      isAbsolute(source) ||
      source !== basename(source) ||
      ![".ts", ".tsx"].includes(extname(source)) ||
      source.slice(0, -extname(source).length) !== id
    ) {
      addDiagnostic(diagnostics, `manifest: ${id} has unsafe or mismatched source ${source}`);
    }
    manifestEntries.set(id, source);
  }
  if (manifestSource !== serializedManifest(manifestEntries)) {
    addDiagnostic(
      diagnostics,
      "manifest: deterministic content is stale; run pnpm --filter zudo-history-stash-doc write:examples-manifest",
    );
  }
  for (const [id, source] of derived) {
    if (manifestEntries.get(id) !== source) {
      addDiagnostic(diagnostics, `manifest: example ${id} must map to ${source}`);
    }
  }
  for (const id of manifestEntries.keys()) {
    if (!derived.has(id)) addDiagnostic(diagnostics, `manifest: stale unreferenced example ${id}`);
  }

  let exampleSources = [];
  try {
    exampleSources = await collectExampleSources(examplesRoot);
  } catch (error) {
    addDiagnostic(diagnostics, `examples directory is unavailable: ${error.message}`);
  }
  const lowerNames = new Map();
  const examplePaths = [];
  const examplesRealRoot = await realpath(examplesRoot).catch(() => null);
  for (const { entry, path, relativePath } of exampleSources) {
    if (relativePath !== basename(relativePath)) {
      addDiagnostic(
        diagnostics,
        `examples: source must be a direct basename beneath examples-check: ${relativePath}`,
      );
      continue;
    }
    const lower = entry.name.toLocaleLowerCase("en-US");
    if (lowerNames.has(lower)) {
      addDiagnostic(
        diagnostics,
        `examples: case-ambiguous sources ${lowerNames.get(lower)} and ${entry.name}`,
      );
    }
    lowerNames.set(lower, entry.name);
    const metadata = await lstat(path);
    if (!entry.isFile() || metadata.isSymbolicLink()) {
      addDiagnostic(
        diagnostics,
        `examples: source must be a regular non-symlink file: ${entry.name}`,
      );
      continue;
    }
    const actualPath = await realpath(path);
    if (examplesRealRoot === null || dirname(actualPath) !== examplesRealRoot) {
      addDiagnostic(diagnostics, `examples: source escapes examples-check: ${entry.name}`);
      continue;
    }
    examplePaths.push(path);
    const id = entry.name.slice(0, -extname(entry.name).length);
    if (manifestEntries.get(id) !== entry.name) {
      addDiagnostic(diagnostics, `examples: unmapped source ${entry.name}`);
    }
  }

  for (const use of uses) {
    const source = manifestEntries.get(use.id);
    if (source === undefined) continue;
    const expectedExtension = use.language === "tsx" ? ".tsx" : ".ts";
    if (extname(source) !== expectedExtension) {
      addDiagnostic(
        diagnostics,
        `example ${use.id}: ${use.language} fence does not match ${source}`,
      );
      continue;
    }
    try {
      const expected = normalizeBytes(await readFile(resolve(examplesRoot, source), "utf8"));
      if (use.code !== expected) {
        addDiagnostic(diagnostics, `example ${use.id}: displayed bytes do not match ${source}`);
      }
    } catch (error) {
      addDiagnostic(
        diagnostics,
        `example ${use.id}: source ${source} is unavailable: ${error.message}`,
      );
    }
  }

  await validateTsconfig(repositoryRoot, tsconfigPath, examplePaths, diagnostics);
  if (diagnostics.size > 0) {
    throw new ExampleCheckError([...diagnostics].sort((left, right) => left.localeCompare(right)));
  }
  if (write) await writeFile(manifestPath, serializedManifest(derived), "utf8");
  return { examples: derived.size, locales: [...locales], sources: examplePaths.length };
}

function parseCli(argv) {
  let write = false;
  for (const argument of argv) {
    if (argument === "--write") write = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return { write };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const result = await checkExamples({ repositoryRoot, ...parseCli(process.argv.slice(2)) });
    console.log(
      `Example parity OK (${result.examples} examples, ${result.sources} sources; ${result.locales.join(", ")})`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
