import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAW_PX = /(-?(?:\d+\.)?\d+)px\b/g;
const ALLOWED_BORDER_WIDTH =
  /^border(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(?:-width)?$/;
const ALLOWED_OUTLINE_WIDTH = /^outline(?:-width|-offset)?$/;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function propertyBefore(line, matchIndex) {
  const before = line.slice(0, matchIndex);
  const matches = Array.from(before.matchAll(/([A-Za-z-]+)\s*:/g));
  return matches.at(-1)?.[1]?.toLowerCase() ?? "";
}

export function lintRawPxText(file, source) {
  const violations = [];
  const clean = stripComments(source);

  for (const [lineIndex, line] of clean.split("\n").entries()) {
    RAW_PX.lastIndex = 0;
    for (const match of line.matchAll(RAW_PX)) {
      const value = Number(match[1]);
      const property = propertyBefore(line, match.index ?? 0);
      const allowed =
        (value === 1 || value === 2) &&
        (ALLOWED_BORDER_WIDTH.test(property) || ALLOWED_OUTLINE_WIDTH.test(property));
      if (!allowed) {
        violations.push({
          file,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          value: match[0],
          property,
        });
      }
    }
  }

  return violations;
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (!entry.name.includes(".test.") && [".css", ".tsx"].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

export async function lintRawPx(root) {
  const files = await sourceFiles(root);
  const results = await Promise.all(
    files.map(async (file) => lintRawPxText(file, await readFile(file, "utf8"))),
  );
  return results.flat();
}

async function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await lintRawPx(resolve(packageRoot, "src"));
  if (violations.length === 0) {
    console.log("UI raw-px lint passed");
    return;
  }

  for (const violation of violations) {
    const property = violation.property.length > 0 ? ` in ${violation.property}` : "";
    console.error(
      `${violation.file}:${violation.line}:${violation.column} raw ${violation.value}${property}; use a design token (only 1px/2px border or outline declarations are allowed)`,
    );
  }
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) await main();
