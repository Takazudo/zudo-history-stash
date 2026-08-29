#!/usr/bin/env node

import { createStashClient } from "@takazudo/zudo-history-stash";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { pathToFileURL } from "node:url";

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

const SITE_FILES = [
  {
    path: "site/index.html",
    contentType: "text/html; charset=utf-8",
    body: [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8">',
      '    <meta name="viewport" content="width=device-width, initial-scale=1">',
      "    <title>History Stash Demo Site</title>",
      '    <link rel="stylesheet" href="/site/styles.css">',
      "  </head>",
      "  <body>",
      '    <main class="card">',
      '      <img src="/site/assets/mark.svg" width="64" height="64" alt="">',
      '      <p class="eyebrow">History Stash</p>',
      "      <h1>Review a live site change</h1>",
      "      <p>This small fixture is committed as one directory-shaped change.</p>",
      '      <a href="/site/about.html">Read the fixture notes</a>',
      "    </main>",
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  },
  {
    path: "site/styles.css",
    contentType: "text/css; charset=utf-8",
    body: [
      ":root {",
      "  color-scheme: light;",
      "  font-family: system-ui, sans-serif;",
      "  background: #f4f7fb;",
      "  color: #172033;",
      "}",
      "",
      "body {",
      "  display: grid;",
      "  min-height: 100vh;",
      "  place-items: center;",
      "  margin: 0;",
      "}",
      "",
      ".card {",
      "  max-width: 36rem;",
      "  padding: 3rem;",
      "  border: 1px solid #d9e2f0;",
      "  border-radius: 1rem;",
      "  background: white;",
      "  box-shadow: 0 1rem 3rem rgb(23 32 51 / 12%);",
      "}",
      "",
      ".eyebrow {",
      "  color: #4666a3;",
      "  font-size: 0.8rem;",
      "  font-weight: 700;",
      "  letter-spacing: 0.12em;",
      "  text-transform: uppercase;",
      "}",
      "",
    ].join("\n"),
  },
  {
    path: "site/about.html",
    contentType: "text/html; charset=utf-8",
    body: [
      "<!doctype html>",
      '<html lang="en">',
      "  <body>",
      "    <main>",
      "      <h1>Fixture notes</h1>",
      "      <p>This page is included to exercise prefix listing and multi-entry commits.</p>",
      "    </main>",
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  },
  {
    path: "site/assets/mark.svg",
    contentType: "image/svg+xml; charset=utf-8",
    body: [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="History Stash">',
      '  <rect width="64" height="64" rx="14" fill="#4666a3"/>',
      '  <path d="M18 17h28v8H26v7h16v8H26v7h20v8H18z" fill="white"/>',
      "</svg>",
      "",
    ].join("\n"),
  },
];

function usage() {
  return "Usage: node scripts/seed-dev.mjs [--base-url URL] [--reset] [--large] [--ci]";
}

export function readOptions(argv, env = process.env) {
  let baseUrl = env.API_BASE_URL || DEFAULT_BASE_URL;
  let reset = false;
  let large = false;
  let ci = false;
  let help = false;

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
    if (argument === "--ci") {
      ci = true;
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
      help = true;
      return { baseUrl, ci, help, large, reset };
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

  return { baseUrl: baseUrl.replace(/\/+$/u, ""), ci, help, large, reset };
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function loadLocalAdminToken({
  env = process.env,
  loadEnvFile = (path) => process.loadEnvFile(path),
} = {}) {
  if (!env.STASH_ADMIN_TOKEN) {
    for (const path of [".dev.vars", "workers/stash/.dev.vars"]) {
      try {
        loadEnvFile(path);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      if (env.STASH_ADMIN_TOKEN) break;
    }
  }

  const token = env.STASH_ADMIN_TOKEN?.trim();
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

async function reportExistingStash(admin, stashName, baseUrl, large, log) {
  if (!large) {
    log(`Stash "${stashName}" already exists; seed skipped.`);
    return;
  }

  const largeResult = await seedLargeFile(admin, stashName);
  log(`Stash "${stashName}" already exists; base seed skipped.`);
  log(
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

async function seedCommitAndChangeSet(client, stashName) {
  const commit = await client.commits(stashName).create(
    {
      entries: [
        {
          op: "put",
          path: "commits/overview.md",
          expectedVersion: null,
          body: "This multi-entry commit is part of the local demo fixture.\n",
        },
        {
          op: "put",
          path: "commits/checklist.txt",
          expectedVersion: null,
          body: "- inspect the commit\n- review the open change set\n",
        },
      ],
      author: "seed-dev",
      message: "Seed multi-entry commit",
      meta: { fixture: "seed-dev-commit" },
    },
    { idempotencyKey: "seed-dev-commit" },
  );
  if (!commit.ok) throw resultError("Creating the seed multi-entry commit", commit);

  const changeSet = await client.changeSets(stashName).create(
    {
      entries: [
        {
          op: "put",
          path: "reviews/pending.md",
          baseVersion: null,
          body: "This change set is intentionally left open for review.\n",
        },
      ],
      author: "seed-dev",
      message: "Seed open change set",
      meta: { fixture: "seed-dev-change-set" },
    },
    { idempotencyKey: "seed-dev-change-set" },
  );
  if (!changeSet.ok) throw resultError("Creating the seed open change set", changeSet);
}

async function seedSiteDirectory(client, stashName) {
  const commit = await client.commits(stashName).create(
    {
      entries: [...SITE_FILES]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map(({ body, contentType, path }) => ({
          op: "put",
          path,
          expectedVersion: null,
          body,
          contentType,
        })),
      author: "seed-dev",
      message: "Seed site directory fixture",
      meta: { fixture: "seed-dev-site-commit" },
    },
    { idempotencyKey: "seed-dev-site-commit" },
  );
  if (!commit.ok) throw resultError("Creating the seed site directory commit", commit);

  const baseStyles = SITE_FILES.find(({ path }) => path === "site/styles.css")?.body ?? "";
  const changeSet = await client.changeSets(stashName).create(
    {
      entries: [
        {
          op: "put",
          path: "site/index.html",
          baseVersion: 1,
          body: [
            "<!doctype html>",
            '<html lang="en">',
            "  <body>",
            '    <main class="card">',
            '      <p class="eyebrow">History Stash</p>',
            "      <h1>Pending reviewer copy</h1>",
            "      <p>This candidate remains open until a reviewer approves it.</p>",
            "    </main>",
            "  </body>",
            "</html>",
            "",
          ].join("\n"),
          contentType: "text/html; charset=utf-8",
        },
        {
          op: "put",
          path: "site/styles.css",
          baseVersion: 1,
          body: `${baseStyles}\n.card {\n  border-color: #6888c7;\n}\n`,
          contentType: "text/css; charset=utf-8",
        },
      ],
      author: "seed-dev",
      message: "Seed open site review",
      meta: { fixture: "seed-dev-site-change-set" },
    },
    { idempotencyKey: "seed-dev-site-change-set" },
  );
  if (!changeSet.ok) throw resultError("Creating the open site change set", changeSet);
}

export async function runSeed({
  argv = process.argv.slice(2),
  env = process.env,
  createClient = createStashClient,
  loadEnvFile,
  log = console.log,
} = {}) {
  const { baseUrl, ci, help, large, reset } = readOptions(argv, env);
  if (help) {
    log(usage());
    return;
  }
  const adminToken = loadLocalAdminToken({ env, loadEnvFile });
  const stashName = reset ? freshResetName() : DEFAULT_STASH_NAME;
  const admin = createClient({ baseUrl, token: adminToken });

  if (!reset) {
    const existing = await admin.stashes.get(stashName);
    if (existing.ok) {
      await reportExistingStash(admin, stashName, baseUrl, large, log);
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
      await reportExistingStash(admin, stashName, baseUrl, large, log);
      return;
    }
    throw resultError(`Creating stash "${stashName}"`, created);
  }

  const tokenResult = await admin.stashes.tokens(stashName).create({
    label: "seed-dev write token",
    scope: "write",
  });
  if (!tokenResult.ok) throw resultError(`Minting a token for "${stashName}"`, tokenResult);

  const writer = createClient({ baseUrl, token: tokenResult.value.token });
  await seedGuideVersions(writer, stashName);
  await seedDeletedNote(writer, stashName);
  await rollbackGuide(writer, stashName);
  await seedCommitAndChangeSet(writer, stashName);
  await seedSiteDirectory(writer, stashName);
  const largeResult = large ? await seedLargeFile(writer, stashName) : null;

  log(`Seeded stash "${stashName}" through ${baseUrl}.`);
  if (largeResult === "created") {
    log(`Seeded ${LARGE_FILE_PATH} (${String(LARGE_FILE_BYTES)} bytes).`);
  }
  if (!ci) log(`Write token (shown once): ${tokenResult.value.token}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSeed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
