#!/usr/bin/env node

import { createStashClient } from "@takazudo/zudo-history-stash";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";

const DEFAULT_BASE_URL = "http://localhost:8787";
const DEFAULT_STASH_NAME = "demo";
const LARGE_FILE_BYTES = 1_500_000;
const LARGE_FILE_PATH = "fixtures/r2-large.txt";
const LARGE_FILE_PREFIX = "History Stash R2 large-file fixture\n";
const LARGE_FILE_SUFFIX = "\nHistory Stash R2 large-file fixture end\n";
const LARGE_FILE_LINE = `${"x".repeat(4_095)}\n`;

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
  return "Usage: node scripts/seed-dev.mjs [--base-url URL] [--reset] [--large]";
}

function readOptions(argv) {
  let baseUrl = process.env.API_BASE_URL || DEFAULT_BASE_URL;
  let reset = false;
  let large = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reset") {
      reset = true;
      continue;
    }
    if (argument === "--large") {
      large = true;
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

  return { baseUrl: baseUrl.replace(/\/+$/u, ""), large, reset };
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
  // Soft deletion never releases a stash name, so every reset needs both time and random suffixes.
  const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
  const random = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `${DEFAULT_STASH_NAME}-reset-${timestamp}-${random}`;
}

function resultError(label, result) {
  return new Error(`${label} failed (${result.error.code}): ${result.error.message}`);
}

function largeFileBody() {
  const fillBytes = LARGE_FILE_BYTES - LARGE_FILE_PREFIX.length - LARGE_FILE_SUFFIX.length;
  const body = `${LARGE_FILE_PREFIX}${LARGE_FILE_LINE.repeat(
    Math.floor(fillBytes / LARGE_FILE_LINE.length),
  )}${"x".repeat(fillBytes % LARGE_FILE_LINE.length)}${LARGE_FILE_SUFFIX}`;
  if (body.length !== LARGE_FILE_BYTES) throw new Error("Large-file fixture size drifted");
  return body;
}

async function seedLargeFile(client, stashName) {
  const files = client.files(stashName);
  const body = largeFileBody();
  const expectedHash = await sha256Hex(body);
  const existing = await files.get(LARGE_FILE_PATH);
  if (existing.ok) {
    if ("notModified" in existing) {
      throw new Error(`Reading ${LARGE_FILE_PATH} unexpectedly returned not-modified`);
    }
    const record = existing.value;
    if (
      record.body !== body ||
      record.size !== LARGE_FILE_BYTES ||
      record.hash !== expectedHash ||
      record.deleted
    ) {
      throw new Error(
        `Existing ${LARGE_FILE_PATH} does not match the reserved large fixture; refusing to overwrite it.`,
      );
    }
    return "existing";
  }
  if (existing.error.code === "file-deleted") {
    throw new Error(
      `${LARGE_FILE_PATH} is tombstoned; use --reset for a fresh stash instead of rewriting history.`,
    );
  }
  if (existing.error.code !== "not-found") {
    throw resultError(`Checking ${LARGE_FILE_PATH}`, existing);
  }

  const put = await files.put(LARGE_FILE_PATH, {
    body,
    expectedVersion: null,
    author: "seed-dev",
    message: "Seed deterministic 1.5 MB R2 fixture",
    meta: { fixture: "seed-dev-large" },
  });
  if (!put.ok) throw resultError(`Writing ${LARGE_FILE_PATH}`, put);
  if (
    "unchanged" in put.value ||
    put.value.version !== 1 ||
    put.value.size !== LARGE_FILE_BYTES ||
    put.value.hash !== expectedHash
  ) {
    throw new Error(`Writing ${LARGE_FILE_PATH} returned an unexpected mutation result`);
  }
  return "created";
}

async function reportExistingStash(admin, stashName, baseUrl, large) {
  if (!large) {
    console.log(`Stash "${stashName}" already exists; seed skipped.`);
    return;
  }

  const largeResult = await seedLargeFile(admin, stashName);
  console.log(`Stash "${stashName}" already exists; base seed skipped.`);
  console.log(
    largeResult === "created"
      ? `Seeded ${LARGE_FILE_PATH} (${String(LARGE_FILE_BYTES)} bytes) through ${baseUrl}.`
      : `${LARGE_FILE_PATH} already matches; large seed skipped.`,
  );
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
  const { baseUrl, large, reset } = readOptions(process.argv.slice(2));
  const adminToken = loadLocalAdminToken();
  const stashName = reset ? freshResetName() : DEFAULT_STASH_NAME;
  const admin = createStashClient({ baseUrl, token: adminToken });

  if (!reset) {
    const existing = await admin.stashes.get(stashName);
    if (existing.ok) {
      await reportExistingStash(admin, stashName, baseUrl, large);
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
      await reportExistingStash(admin, stashName, baseUrl, large);
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
  const largeResult = large ? await seedLargeFile(writer, stashName) : null;

  console.log(`Seeded stash "${stashName}" through ${baseUrl}.`);
  if (largeResult === "created") {
    console.log(`Seeded ${LARGE_FILE_PATH} (${String(LARGE_FILE_BYTES)} bytes).`);
  }
  console.log(`Write token (shown once): ${tokenResult.value.token}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
