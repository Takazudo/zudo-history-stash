import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "src");
const outputFile = resolve(packageRoot, "dist/styles.css");
const centralStyleIndex = "styles/index.css";

function relativeStylePath(root, file) {
  return relative(root, file).split(sep).join("/");
}

async function walkCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkCssFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function discoverStyleFiles(root) {
  const indexFile = resolve(root, centralStyleIndex);
  const indexSource = await readFile(indexFile, "utf8");
  const sourceWithoutComments = indexSource.replace(/\/\*[\s\S]*?\*\//gu, "");
  const importPattern = /@import\s+["']([^"']+)["']\s*;/gu;
  const imports = [...sourceWithoutComments.matchAll(importPattern)];
  const unexpectedSource = sourceWithoutComments.replace(importPattern, "").trim();

  if (imports.length === 0) {
    throw new Error(`${centralStyleIndex} must import at least one stylesheet`);
  }
  if (unexpectedSource) {
    throw new Error(`${centralStyleIndex} may contain only quoted @import statements`);
  }

  const indexedFiles = [];
  const indexedPaths = new Set();
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier?.startsWith(".") || !specifier.endsWith(".css")) {
      throw new Error(`${centralStyleIndex} contains an invalid stylesheet import: ${specifier}`);
    }
    const file = resolve(dirname(indexFile), specifier);
    const path = relativeStylePath(root, file);
    const rootRelativePath = relative(root, file);
    if (
      rootRelativePath === "" ||
      rootRelativePath === ".." ||
      rootRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(rootRelativePath) ||
      path === centralStyleIndex
    ) {
      throw new Error(`${centralStyleIndex} imports a stylesheet outside its source manifest`);
    }
    if (indexedPaths.has(path)) {
      throw new Error(`${centralStyleIndex} imports ${path} more than once`);
    }
    indexedPaths.add(path);
    indexedFiles.push(file);
  }

  const discoveredPaths = new Set(
    (await walkCssFiles(root))
      .map((file) => relativeStylePath(root, file))
      .filter((path) => path !== centralStyleIndex),
  );
  const missing = [...indexedPaths].filter((path) => !discoveredPaths.has(path));
  const omitted = [...discoveredPaths].filter((path) => !indexedPaths.has(path)).sort();
  if (missing.length > 0) {
    throw new Error(`${centralStyleIndex} imports missing stylesheets: ${missing.join(", ")}`);
  }
  if (omitted.length > 0) {
    throw new Error(`${centralStyleIndex} does not list stylesheets: ${omitted.join(", ")}`);
  }

  return indexedFiles;
}

export async function createStylesheet(root) {
  const styleFiles = await discoverStyleFiles(root);
  if (styleFiles.length === 0) throw new Error("No UI component styles were found");

  const sources = await Promise.all(
    styleFiles.map(async (file) => {
      const path = relativeStylePath(root, file);
      const source = await readFile(file, "utf8");
      if (/@import\b/iu.test(source.replace(/\/\*[\s\S]*?\*\//gu, ""))) {
        throw new Error(`${path} contains a nested @import; add it to ${centralStyleIndex}`);
      }
      return `/* ${path} */\n${source.trim()}\n`;
    }),
  );

  return `${sources.join("\n")}\n`;
}

export async function buildStyles(root, destination) {
  const stylesheet = await createStylesheet(root);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, stylesheet, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildStyles(sourceRoot, outputFile);
}
