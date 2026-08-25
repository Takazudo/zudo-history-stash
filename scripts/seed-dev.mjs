#!/usr/bin/env node

import { createStashClient } from "@takazudo/zudo-history-stash";

const DEFAULT_BASE_URL = "http://localhost:8787";
const DEFAULT_STASH_NAME = "demo";

const GUIDE_VERSIONS = [
  {
    body: "# Guide\n\nWelcome to the History Stash demo.\n",
    message: "Seed guide v1",
  },
  {
    body: "# ガイド\n\n履歴を安全に確認できるデモです。\n",
    message: "Seed Japanese guide v2",
  },
  {
    body: "# Guide\r\n\r\nThis version intentionally uses CRLF.\r\n",
    message: "Seed CRLF guide v3",
  },
];

function usage() {
  return "Usage: node scripts/seed-dev.mjs [--base-url URL] [--reset]";
}

function readOptions(argv) {
  let baseUrl = process.env.API_BASE_URL || DEFAULT_BASE_URL;
  let reset = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reset") {
      reset = true;
      continue;
    }
    if (argument === "--base-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(usage());
      baseUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`${usage()}\nUnknown argument: ${argument}`);
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid --base-url: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--base-url must use http or https: ${baseUrl}`);
  }

  return { baseUrl: baseUrl.replace(/\/+$/u, ""), reset };
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function loadLocalAdminToken() {
  if (!process.env.STASH_ADMIN_TOKEN) {
    for (const path of [".dev.vars", "workers/stash/.dev.vars"]) {
      try {
        process.loadEnvFile(path);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      if (process.env.STASH_ADMIN_TOKEN) break;
    }
  }

  const token = process.env.STASH_ADMIN_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "STASH_ADMIN_TOKEN is required; export it or copy workers/stash/.dev.vars.example to workers/stash/.dev.vars.",
    );
  }
  return token;
}

function freshResetName() {
  const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
  const random = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `${DEFAULT_STASH_NAME}-reset-${timestamp}-${random}`;
}

function resultError(label, result) {
  return new Error(`${label} failed (${result.error.code}): ${result.error.message}`);
}

async function seedGuideVersions(client, stashName) {
  const files = client.files(stashName);
  for (const [index, version] of GUIDE_VERSIONS.entries()) {
    const expectedVersion = index === 0 ? null : index;
    const result = await files.put("docs/guide.md", {
      body: version.body,
      expectedVersion,
      author: "seed-dev",
      message: version.message,
    });
    if (!result.ok) throw resultError(`Writing docs/guide.md v${index + 1}`, result);
  }
}

async function rollbackGuide(client, stashName) {
  const files = client.files(stashName);
  const rollback = await files.rollback("docs/guide.md", {
    toVersion: 1,
    expectedVersion: GUIDE_VERSIONS.length,
    author: "seed-dev",
    message: "Rollback guide to v1",
  });
  if (!rollback.ok) throw resultError("Rolling docs/guide.md back to v1", rollback);
}

async function seedDeletedNote(client, stashName) {
  const files = client.files(stashName);
  const put = await files.put("notes/todo.txt", {
    body: "- verify the live History Stash lane\n",
    expectedVersion: null,
    author: "seed-dev",
    message: "Seed todo note",
  });
  if (!put.ok) throw resultError("Writing notes/todo.txt v1", put);

  const deleted = await files.delete("notes/todo.txt", {
    expectedVersion: 1,
    author: "seed-dev",
    message: "Delete completed todo note",
  });
  if (!deleted.ok) throw resultError("Deleting notes/todo.txt", deleted);
}

async function main() {
  const { baseUrl, reset } = readOptions(process.argv.slice(2));
  const adminToken = loadLocalAdminToken();
  const stashName = reset ? freshResetName() : DEFAULT_STASH_NAME;
  const admin = createStashClient({ baseUrl, token: adminToken });

  if (!reset) {
    const existing = await admin.stashes.get(stashName);
    if (existing.ok) {
      console.log(`Stash "${stashName}" already exists; seed skipped.`);
      return;
    }
    if (existing.error.code !== "not-found") {
      throw resultError(`Checking stash "${stashName}"`, existing);
    }
  }

  const created = await admin.stashes.create({
    name: stashName,
    description: "Deterministic local live-integration fixture",
    meta: { fixture: "seed-dev" },
  });
  if (!created.ok) {
    if (!reset && created.error.code === "exists") {
      console.log(`Stash "${stashName}" already exists; seed skipped.`);
      return;
    }
    throw resultError(`Creating stash "${stashName}"`, created);
  }

  const tokenResult = await admin.stashes.tokens(stashName).create({
    label: "seed-dev write token",
    scope: "write",
  });
  if (!tokenResult.ok) throw resultError(`Minting a token for "${stashName}"`, tokenResult);

  const writer = createStashClient({ baseUrl, token: tokenResult.value.token });
  await seedGuideVersions(writer, stashName);
  await seedDeletedNote(writer, stashName);
  await rollbackGuide(writer, stashName);

  console.log(`Seeded stash "${stashName}" through ${baseUrl}.`);
  console.log(`Write token (shown once): ${tokenResult.value.token}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
