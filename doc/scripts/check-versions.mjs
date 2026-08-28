#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./tooling-utils.mjs";

export const VERSION_SOURCES = {
  core: "../../../packages/core/package.json",
  client: "../../../packages/client/package.json",
  ui: "../../../packages/ui/package.json",
  api: "../../../docs/openapi.json",
  node: "../../../package.json",
  pnpm: "../../../package.json",
  wrangler: "../../package.json",
};

export async function authoritativeVersions(repositoryRoot) {
  const [core, client, ui, openapi, root, doc] = await Promise.all([
    readJson(resolve(repositoryRoot, "packages/core/package.json")),
    readJson(resolve(repositoryRoot, "packages/client/package.json")),
    readJson(resolve(repositoryRoot, "packages/ui/package.json")),
    readJson(resolve(repositoryRoot, "docs/openapi.json")),
    readJson(resolve(repositoryRoot, "package.json")),
    readJson(resolve(repositoryRoot, "doc/package.json")),
  ]);
  return {
    core: core.version,
    client: client.version,
    ui: ui.version,
    api: openapi.info.version,
    node: root.engines.node,
    pnpm: root.packageManager,
    wrangler: doc.devDependencies.wrangler,
  };
}

export async function checkVersions(repositoryRoot) {
  const modelPath = resolve(repositoryRoot, "doc/src/data/versions.ts");
  const chromePath = resolve(repositoryRoot, "doc/src/chrome-bindings.tsx");
  const pages = [
    resolve(repositoryRoot, "doc/src/content/docs/reference/versions.mdx"),
    resolve(repositoryRoot, "doc/src/content/docs-ja/reference/versions.mdx"),
  ];
  const [model, chrome, ...pageSources] = await Promise.all([
    readFile(modelPath, "utf8"),
    readFile(chromePath, "utf8"),
    ...pages.map((path) => readFile(path, "utf8")),
  ]);

  if (/from\s+["']node:fs(?:\/promises)?["']|require\s*\(\s*["']node:fs/.test(model + chrome)) {
    throw new Error("version model must not use runtime node:fs access");
  }
  for (const [name, source] of Object.entries(VERSION_SOURCES)) {
    if (!model.includes(`from \"${source}\"`) && !model.includes(`from '${source}'`)) {
      throw new Error(`version model is not wired to ${name} source ${source}`);
    }
  }
  const expectedExpressions = {
    core: "corePackage.version",
    client: "clientPackage.version",
    ui: "uiPackage.version",
    api: "openApi.info.version",
    node: "rootPackage.engines.node",
    pnpm: "rootPackage.packageManager",
    wrangler: "docPackage.devDependencies.wrangler",
  };
  for (const [name, expression] of Object.entries(expectedExpressions)) {
    const pattern = new RegExp(`\\b${name}\\s*:\\s*${expression.replaceAll(".", "\\.")}\\s*[,}]`);
    if (!pattern.test(model)) throw new Error(`version model field ${name} must use ${expression}`);
  }
  if (
    !chrome.includes('from "./data/versions.ts"') &&
    !chrome.includes("from './data/versions.ts'")
  ) {
    throw new Error("chrome bindings are not wired to the shared version model");
  }
  if (!/mdxExtras\s*:\s*\{\s*VersionValue\s*\}/s.test(chrome)) {
    throw new Error("chrome bindings do not expose VersionValue to both MDX trees");
  }
  for (let index = 0; index < pageSources.length; index += 1) {
    const source = pageSources[index];
    const label = index === 0 ? "English" : "Japanese";
    for (const name of Object.keys(VERSION_SOURCES)) {
      const matches = source.match(
        new RegExp(`<VersionValue\\s+name=["']${name}["']\\s*\\/>`, "g"),
      );
      if (matches?.length !== 1) {
        throw new Error(`${label} versions page must render ${name} exactly once`);
      }
    }
    if (/\b(?:v)?\d+\.\d+(?:\.\d+)?\b/.test(source)) {
      throw new Error(`${label} versions page contains a copied numeric version literal`);
    }
  }
  const values = await authoritativeVersions(repositoryRoot);
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`authoritative ${name} version value is missing`);
    }
  }
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  checkVersions(resolve(scriptDir, "../.."))
    .then((versions) => {
      console.log(`Version wiring OK (${Object.keys(versions).join(", ")})`);
    })
    .catch((error) => {
      console.error(`Version wiring failed: ${error.message}`);
      process.exitCode = 1;
    });
}
