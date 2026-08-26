import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStyles, discoverStyleFiles } from "./build-css.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("builds nested component styles in deterministic order and skips the central index", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "zhs-ui-css-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sourceRoot = join(fixtureRoot, "src");
  const outputFile = join(fixtureRoot, "dist/styles.css");
  const files = {
    nested: join(sourceRoot, "components/button/button.css"),
    primitive: join(sourceRoot, "styles/primitives.css"),
    index: join(sourceRoot, "styles/index.css"),
  };

  await Promise.all([
    mkdir(dirname(files.nested), { recursive: true }),
    mkdir(dirname(files.primitive), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(files.nested, ".nested-component { color: var(--theme-ink); }\n", "utf8"),
    writeFile(files.primitive, ".primitive { color: var(--theme-ink-muted); }\n", "utf8"),
    writeFile(files.index, '@import "./primitives.css";\n', "utf8"),
  ]);

  const discovered = await discoverStyleFiles(sourceRoot);
  assert.deepEqual(
    discovered.map((file) => relative(sourceRoot, file).replaceAll("\\", "/")),
    ["components/button/button.css", "styles/primitives.css"],
  );

  await buildStyles(sourceRoot, outputFile);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /\/\* components\/button\/button\.css \*\//);
  assert.match(output, /\.nested-component/);
  assert.match(output, /\/\* styles\/primitives\.css \*\//);
  assert.doesNotMatch(output, /@import/);
});

test("keeps primitive state colors under host token control", async () => {
  const css = await readFile(resolve(packageRoot, "src/styles/primitives.css"), "utf8");

  assert.doesNotMatch(css, /:\s*transparent\s*;/);
  assert.doesNotMatch(css, /\bfilter\s*:/);
  for (const token of [
    "--theme-transparent",
    "--button-primary-hover-bg",
    "--button-primary-hover-fg",
    "--button-danger-hover-bg",
    "--button-danger-hover-fg",
  ]) {
    assert.match(css, new RegExp(`var\\(${token}\\)`));
  }
});
