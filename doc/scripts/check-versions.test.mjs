import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkVersions } from "./check-versions.mjs";

const fields = ["core", "client", "ui", "api", "node", "pnpm", "wrangler"];

async function versionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhs-versions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "packages/core",
    "packages/client",
    "packages/ui",
    "docs",
    "doc/src/data",
    "doc/src/content/docs/reference",
    "doc/src/content/docs-ja/reference",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const name of ["core", "client", "ui"]) {
    await writeFile(
      join(root, `packages/${name}/package.json`),
      JSON.stringify({ version: "1.2.3" }),
    );
  }
  await writeFile(join(root, "docs/openapi.json"), JSON.stringify({ info: { version: "1.2.3" } }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ engines: { node: ">=22.13.0" }, packageManager: "pnpm@10.32.0" }),
  );
  await writeFile(
    join(root, "doc/package.json"),
    JSON.stringify({ devDependencies: { wrangler: "4.125.0" } }),
  );
  await writeFile(
    join(root, "doc/src/data/versions.ts"),
    [
      'import clientPackage from "../../../packages/client/package.json";',
      'import corePackage from "../../../packages/core/package.json";',
      'import openApi from "../../../docs/openapi.json";',
      'import rootPackage from "../../../package.json";',
      'import uiPackage from "../../../packages/ui/package.json";',
      'import docPackage from "../../package.json";',
      "export const projectVersions = {",
      "  core: corePackage.version,",
      "  client: clientPackage.version,",
      "  ui: uiPackage.version,",
      "  api: openApi.info.version,",
      "  node: rootPackage.engines.node,",
      "  pnpm: rootPackage.packageManager,",
      "  wrangler: docPackage.devDependencies.wrangler,",
      "} as const;",
    ].join("\n"),
  );
  await writeFile(
    join(root, "doc/src/chrome-bindings.tsx"),
    [
      'import { projectVersions } from "./data/versions.ts";',
      "function VersionValue({ name }) { return projectVersions[name]; }",
      "export const chromeBindings = defineChromeBindings({ mdxExtras: { VersionValue } });",
    ].join("\n"),
  );
  const page = fields.map((name) => `<VersionValue name="${name}" />`).join("\n");
  await writeFile(join(root, "doc/src/content/docs/reference/versions.mdx"), page);
  await writeFile(join(root, "doc/src/content/docs-ja/reference/versions.mdx"), page);
  return root;
}

test("version checker accepts one source-derived model wired to both locales", async (t) => {
  const root = await versionFixture(t);
  assert.deepEqual(await checkVersions(root), {
    core: "1.2.3",
    client: "1.2.3",
    ui: "1.2.3",
    api: "1.2.3",
    node: ">=22.13.0",
    pnpm: "pnpm@10.32.0",
    wrangler: "4.125.0",
  });
});

test("version checker rejects wrong source, missing field, detached locale, copied literal, and runtime fs", async (t) => {
  await t.test("wrong source", async (t) => {
    const root = await versionFixture(t);
    const path = join(root, "doc/src/data/versions.ts");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("packages/core", "packages/client"),
    );
    await assert.rejects(checkVersions(root), /not wired to core source/);
  });
  await t.test("missing field", async (t) => {
    const root = await versionFixture(t);
    const path = join(root, "doc/src/content/docs/reference/versions.mdx");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace('<VersionValue name="api" />', ""),
    );
    await assert.rejects(checkVersions(root), /English versions page must render api exactly once/);
  });
  await t.test("detached locale", async (t) => {
    const root = await versionFixture(t);
    const path = join(root, "doc/src/content/docs-ja/reference/versions.mdx");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace('<VersionValue name="wrangler" />', ""),
    );
    await assert.rejects(
      checkVersions(root),
      /Japanese versions page must render wrangler exactly once/,
    );
  });
  await t.test("copied literal", async (t) => {
    const root = await versionFixture(t);
    const path = join(root, "doc/src/content/docs/reference/versions.mdx");
    await writeFile(path, `${await readFile(path, "utf8")}\nCopied: 4.125.0\n`);
    await assert.rejects(checkVersions(root), /copied numeric version literal/);
  });
  await t.test("runtime fs", async (t) => {
    const root = await versionFixture(t);
    const path = join(root, "doc/src/data/versions.ts");
    await writeFile(path, `import fs from "node:fs";\n${await readFile(path, "utf8")}`);
    await assert.rejects(checkVersions(root), /must not use runtime node:fs/);
  });
});
