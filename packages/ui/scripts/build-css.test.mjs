import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStyles, createStylesheet, discoverStyleFiles } from "./build-css.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("builds every indexed stylesheet in declared order without emitting imports", async (t) => {
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
    writeFile(files.nested, ".zhs-delete-file-dialog { inline-size: min(100%, 34rem); }\n", "utf8"),
    writeFile(files.primitive, ".zhs-dialog { inline-size: min(100%, 56rem); }\n", "utf8"),
    writeFile(
      files.index,
      '@import "./primitives.css";\n@import "../components/button/button.css";\n',
      "utf8",
    ),
  ]);

  const discovered = await discoverStyleFiles(sourceRoot);
  assert.deepEqual(
    discovered.map((file) => relative(sourceRoot, file).replaceAll("\\", "/")),
    ["styles/primitives.css", "components/button/button.css"],
  );

  await buildStyles(sourceRoot, outputFile);
  const output = await readFile(outputFile, "utf8");
  const primitiveOffset = output.indexOf("/* styles/primitives.css */");
  const componentOffset = output.indexOf("/* components/button/button.css */");
  assert.ok(primitiveOffset >= 0);
  assert.ok(componentOffset > primitiveOffset);
  assert.ok(output.indexOf("56rem", primitiveOffset) < output.indexOf("34rem", componentOffset));
  assert.doesNotMatch(output, /@import/);
});

test("rejects stylesheets omitted from the central index", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "zhs-ui-css-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const sourceRoot = join(fixtureRoot, "src");
  const stylesRoot = join(sourceRoot, "styles");
  await mkdir(stylesRoot, { recursive: true });
  await Promise.all([
    writeFile(join(stylesRoot, "index.css"), '@import "./primitives.css";\n', "utf8"),
    writeFile(join(stylesRoot, "primitives.css"), ".zhs-button {}\n", "utf8"),
    writeFile(join(stylesRoot, "unlisted.css"), ".zhs-notice {}\n", "utf8"),
  ]);

  await assert.rejects(
    discoverStyleFiles(sourceRoot),
    /styles\/index\.css does not list stylesheets: styles\/unlisted\.css/u,
  );
});

test("places generic primitives before package component overrides", async () => {
  const output = await createStylesheet(resolve(packageRoot, "src"));
  const primitiveOffset = output.indexOf("/* styles/primitives.css */");
  const deleteDialogOffset = output.indexOf("/* components/delete-file-dialog.css */");
  const genericWidthOffset = output.indexOf(
    "inline-size: min(calc(100% - var(--hsp-xl)), 56rem);",
    primitiveOffset,
  );
  const deleteWidthOffset = output.indexOf(
    "inline-size: min(calc(100% - (2 * var(--hsp-xl))), 34rem);",
    deleteDialogOffset,
  );

  assert.ok(primitiveOffset >= 0);
  assert.ok(deleteDialogOffset > primitiveOffset);
  assert.ok(genericWidthOffset > primitiveOffset);
  assert.ok(deleteWidthOffset > deleteDialogOffset);
  assert.ok(genericWidthOffset < deleteWidthOffset);
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
