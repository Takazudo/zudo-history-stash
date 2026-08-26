import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
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
  return (await walkCssFiles(root))
    .filter((file) => relativeStylePath(root, file) !== centralStyleIndex)
    .sort((left, right) => {
      const leftPath = relativeStylePath(root, left);
      const rightPath = relativeStylePath(root, right);
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
}

export async function createStylesheet(root) {
  const styleFiles = await discoverStyleFiles(root);
  if (styleFiles.length === 0) throw new Error("No UI component styles were found");

  const sources = await Promise.all(
    styleFiles.map(async (file) => {
      const path = relativeStylePath(root, file);
      return `/* ${path} */\n${(await readFile(file, "utf8")).trim()}\n`;
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
