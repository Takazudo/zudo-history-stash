import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPinParity, ZFB_PACKAGES, ZUDO_PACKAGES } from "./check-pin-parity.mjs";
import { checkWranglerPin, EXPECTED_WRANGLER_VERSION } from "./check-wrangler-pin.mjs";
import { parseLockImporter } from "./tooling-utils.mjs";

function lockDependency(name, version, quote = "'") {
  const key = name.startsWith("@") ? `'${name}'` : name;
  return [
    `      ${key}:`,
    `        specifier: ${quote}${version}${quote}`,
    `        version: ${quote}${version}(@peer/example@1.0.0)${quote}`,
  ].join("\n");
}

function lockSource(overrides = {}) {
  const zfbVersions = Object.fromEntries(ZFB_PACKAGES.map((name) => [name, "2.12.0"]));
  const zudoVersions = Object.fromEntries(ZUDO_PACKAGES.map((name) => [name, "5.13.0"]));
  const versions = {
    ...zfbVersions,
    ...zudoVersions,
    wrangler: EXPECTED_WRANGLER_VERSION,
    ...overrides,
  };
  const docEntries = Object.entries(versions)
    .map(([name, version], index) => lockDependency(name, version, index % 2 === 0 ? "'" : '"'))
    .join("\n");
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  '.':",
    "    devDependencies:",
    lockDependency("wrangler", EXPECTED_WRANGLER_VERSION, '"'),
    "",
    "  doc:",
    "    devDependencies:",
    docEntries,
    "",
  ].join("\n");
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhs-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "doc"));
  const dependencies = Object.fromEntries(
    [...ZFB_PACKAGES.slice(0, 3), ...ZUDO_PACKAGES.slice(0, 2)].map((name) => [
      name,
      name.startsWith("@takazudo/zfb") ? "2.12.0" : "5.13.0",
    ]),
  );
  const devDependencies = {
    [ZFB_PACKAGES[3]]: "2.12.0",
    [ZUDO_PACKAGES[2]]: "5.13.0",
    wrangler: EXPECTED_WRANGLER_VERSION,
  };
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { wrangler: EXPECTED_WRANGLER_VERSION } }),
  );
  await writeFile(
    join(root, "doc/package.json"),
    JSON.stringify({ dependencies, devDependencies }),
  );
  await writeFile(
    join(root, "doc/.zudo-doc.json"),
    JSON.stringify(options.provenance ?? { packageVersion: "5.13.0", ejected: {} }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), options.lock ?? lockSource());
  return root;
}

test("pin checkers accept exact pins, quoted YAML scalars, and peer-suffixed resolutions", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await checkPinParity(root), {
    zfbVersion: "2.12.0",
    zudoVersion: "5.13.0",
  });
  assert.equal(await checkWranglerPin(root), EXPECTED_WRANGLER_VERSION);
  assert.equal(
    parseLockImporter(await readFile(join(root, "pnpm-lock.yaml"), "utf8"), "doc").size,
    8,
  );
});

test("pin parity rejects ranges, duplicate declarations, family drift, and malformed provenance", async (t) => {
  await t.test("range", async (t) => {
    const root = await fixture(t);
    const manifestPath = join(root, "doc/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies["@takazudo/zudo-doc"] = "^5.13.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(checkPinParity(root), /must be an exact version/);
  });

  await t.test("duplicate", async (t) => {
    const root = await fixture(t);
    const manifestPath = join(root, "doc/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies["create-zudo-doc"] = "5.13.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(checkPinParity(root), /multiple dependency fields/);
  });

  await t.test("family mismatch", async (t) => {
    const root = await fixture(t, { lock: lockSource({ "@takazudo/zfb-runtime": "2.13.0" }) });
    const manifestPath = join(root, "doc/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies["@takazudo/zfb-runtime"] = "2.13.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(checkPinParity(root), /zfb family mismatch/);
  });

  await t.test("provenance schema", async (t) => {
    const root = await fixture(t, {
      provenance: { packageVersion: "5.13.0", ejected: {}, unexpected: true },
    });
    await assert.rejects(checkPinParity(root), /contain only packageVersion/);
  });
});

test("Wrangler checker rejects ranges, mismatches, missing importers, and wrong resolution cores", async (t) => {
  await t.test("root range", async (t) => {
    const root = await fixture(t);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { wrangler: `^${EXPECTED_WRANGLER_VERSION}` } }),
    );
    await assert.rejects(checkWranglerPin(root), /must be an exact version/);
  });

  await t.test("doc mismatch", async (t) => {
    const root = await fixture(t);
    const manifestPath = join(root, "doc/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.devDependencies.wrangler = "4.124.0";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(checkWranglerPin(root), /must be 4\.125\.0/);
  });

  await t.test("wrong lock resolution", async (t) => {
    const root = await fixture(t);
    const lockPath = join(root, "pnpm-lock.yaml");
    const lock = await readFile(lockPath, "utf8");
    await writeFile(
      lockPath,
      lock.replace(
        `version: \"${EXPECTED_WRANGLER_VERSION}(@peer/example@1.0.0)\"`,
        'version: "4.124.0(@peer/example@1.0.0)"',
      ),
    );
    await assert.rejects(checkWranglerPin(root), /resolution must be 4\.125\.0/);
  });

  await t.test("missing importer", async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nimporters:\n  doc:\n");
    await assert.rejects(checkWranglerPin(root), /no \. importer/);
  });
});
