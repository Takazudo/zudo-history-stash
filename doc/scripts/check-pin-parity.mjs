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

export const ZFB_PACKAGES = [
  "@takazudo/zfb",
  "@takazudo/zfb-runtime",
  "@takazudo/zfb-md-wasm",
  "@takazudo/zfb-adapter-cloudflare",
];

export const ZUDO_PACKAGES = [
  "@takazudo/zudo-doc",
  "@takazudo/zudo-doc-history-server",
  "create-zudo-doc",
];

export async function checkPinParity(repositoryRoot) {
  const docRoot = resolve(repositoryRoot, "doc");
  const [manifest, provenance, lockSource] = await Promise.all([
    readJson(resolve(docRoot, "package.json")),
    readJson(resolve(docRoot, ".zudo-doc.json")),
    readFile(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
  ]);
  const importer = parseLockImporter(lockSource, "doc");

  const provenanceKeys = Object.keys(provenance).sort();
  if (
    JSON.stringify(provenanceKeys) !== JSON.stringify(["ejected", "packageVersion"]) ||
    provenance.ejected === null ||
    Array.isArray(provenance.ejected) ||
    typeof provenance.ejected !== "object"
  ) {
    throw new Error(
      "doc/.zudo-doc.json must contain only packageVersion and object-valued ejected",
    );
  }

  const versions = new Map();
  for (const name of [...ZFB_PACKAGES, ...ZUDO_PACKAGES]) {
    const declaration = directDependency(manifest, name, "doc/package.json");
    const version = assertExactVersion(declaration.value, `doc/package.json ${name}`);
    assertLockedDependency(importer, name, version, "doc");
    versions.set(name, version);
  }

  const zfbVersion = versions.get(ZFB_PACKAGES[0]);
  for (const name of ZFB_PACKAGES) {
    if (versions.get(name) !== zfbVersion) {
      throw new Error(
        `zfb family mismatch: ${name} is ${versions.get(name)}, expected ${zfbVersion}`,
      );
    }
  }

  const zudoVersion = versions.get(ZUDO_PACKAGES[0]);
  for (const name of ZUDO_PACKAGES) {
    if (versions.get(name) !== zudoVersion) {
      throw new Error(
        `zudo-doc family mismatch: ${name} is ${versions.get(name)}, expected ${zudoVersion}`,
      );
    }
  }
  if (provenance.packageVersion !== zudoVersion) {
    throw new Error(
      `doc/.zudo-doc.json packageVersion is ${provenance.packageVersion}, expected ${zudoVersion}`,
    );
  }
  return { zfbVersion, zudoVersion };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  checkPinParity(resolve(scriptDir, "../.."))
    .then(({ zfbVersion, zudoVersion }) => {
      console.log(`Pin parity OK (zfb ${zfbVersion}; zudo-doc ${zudoVersion})`);
    })
    .catch((error) => {
      console.error(`Pin parity failed: ${error.message}`);
      process.exitCode = 1;
    });
}
