#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExactVersion,
  assertLockedDependency,
  directDependency,
  parseLockImporter,
  readJson,
} from "./tooling-utils.mjs";

export const EXPECTED_WRANGLER_VERSION = "4.125.0";

export async function checkWranglerPin(repositoryRoot) {
  const [rootManifest, docManifest, lockSource] = await Promise.all([
    readJson(resolve(repositoryRoot, "package.json")),
    readJson(resolve(repositoryRoot, "doc/package.json")),
    readFile(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
  ]);

  for (const [label, manifest] of [
    ["package.json", rootManifest],
    ["doc/package.json", docManifest],
  ]) {
    const declaration = directDependency(manifest, "wrangler", label);
    const version = assertExactVersion(declaration.value, `${label} wrangler`);
    if (version !== EXPECTED_WRANGLER_VERSION) {
      throw new Error(
        `${label} wrangler must be ${EXPECTED_WRANGLER_VERSION}, received ${version}`,
      );
    }
  }

  assertLockedDependency(
    parseLockImporter(lockSource, "."),
    "wrangler",
    EXPECTED_WRANGLER_VERSION,
    "root",
  );
  assertLockedDependency(
    parseLockImporter(lockSource, "doc"),
    "wrangler",
    EXPECTED_WRANGLER_VERSION,
    "doc",
  );
  return EXPECTED_WRANGLER_VERSION;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  checkWranglerPin(resolve(scriptDir, "../.."))
    .then((version) => console.log(`Wrangler pin OK (${version})`))
    .catch((error) => {
      console.error(`Wrangler pin failed: ${error.message}`);
      process.exitCode = 1;
    });
}
