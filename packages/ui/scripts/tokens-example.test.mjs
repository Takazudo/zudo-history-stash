import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

test("keeps the shipped token example byte-identical to the Viewer reference", async () => {
  const [example, viewer] = await Promise.all([
    readFile(resolve(packageRoot, "styles/tokens.example.css"), "utf8"),
    readFile(resolve(repositoryRoot, "workers/viewer/src/styles/tokens.css"), "utf8"),
  ]);

  assert.equal(
    example,
    viewer,
    "Copy workers/viewer/src/styles/tokens.css to packages/ui/styles/tokens.example.css",
  );
});
