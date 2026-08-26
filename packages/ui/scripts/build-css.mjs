import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesRoot = resolve(packageRoot, "src/styles");
const distRoot = resolve(packageRoot, "dist");

const styleFiles = (await readdir(stylesRoot))
  .filter((name) => name.endsWith(".css") && name !== "index.css")
  .sort();

if (styleFiles.length === 0) throw new Error("No UI component styles were found");

const sources = await Promise.all(
  styleFiles.map(
    async (name) =>
      `/* ${name} */\n${(await readFile(resolve(stylesRoot, name), "utf8")).trim()}\n`,
  ),
);

await mkdir(distRoot, { recursive: true });
await writeFile(resolve(distRoot, "styles.css"), `${sources.join("\n")}\n`, "utf8");
