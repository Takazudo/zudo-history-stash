import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { MAX_COMMIT_INLINE_BYTES, sha256Hex } from "@takazudo/zudo-history-stash-core";

import {
  chunkEntries,
  deriveEntries,
  listRemoteHeads,
  planDirectory,
  readOptions,
  runCommitDir,
  walkDirectory,
} from "./commit-dir.mjs";

const ADMIN_TOKEN = "do-not-print-this-token";
const BASE_URL = "https://stash.example.test/api";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixtureDirectory(files) {
  const directory = await mkdtemp(join(tmpdir(), "zhs-commit-dir-"));
  temporaryDirectories.push(directory);
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = join(directory, relativePath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, value);
  }
  return directory;
}

async function fixtureStateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "zhs-commit-dir-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function summary(path, bytes, headVersion, { deleted = false } = {}) {
  return {
    path,
    headVersion,
    hash: deleted ? null : await sha256Hex(bytes),
    size: deleted ? 0 : bytes.byteLength,
    deleted,
  };
}

function emptyPageClient({ pages, calls = [] }) {
  return {
    calls,
    files: {
      async list(options) {
        calls.push(options);
        const page = pages.shift();
        if (!page) throw new Error("unexpected list call");
        return { ok: true, value: page };
      },
    },
  };
}

describe("commit-dir derivation", () => {
  it("derives create, update, prune-delete, and canonical binary entries in path order", async () => {
    const directory = await fixtureDirectory({
      "changed.txt": "new value\n",
      "nested/image.bin": Uint8Array.from([0, 255, 1]),
      "new.txt": "created\n",
      "same.txt": "unchanged\n",
    });
    const remoteFiles = [
      await summary("site/old.txt", new TextEncoder().encode("old\n"), 4),
      await summary("site/same.txt", new TextEncoder().encode("unchanged\n"), 7),
      await summary("site/changed.txt", new TextEncoder().encode("old value\n"), 3),
    ];
    const entries = await deriveEntries({
      directory,
      prefix: "site",
      prune: true,
      remoteFiles,
    });

    assert.deepEqual(entries, [
      {
        op: "put",
        path: "site/changed.txt",
        expectedVersion: 3,
        body: "new value\n",
        contentType: "text/plain; charset=utf-8",
      },
      {
        op: "put",
        path: "site/nested/image.bin",
        expectedVersion: null,
        representation: "binary",
        contentType: "application/octet-stream",
        bytesBase64: "AP8B",
      },
      {
        op: "put",
        path: "site/new.txt",
        expectedVersion: null,
        body: "created\n",
        contentType: "text/plain; charset=utf-8",
      },
      { op: "delete", path: "site/old.txt", expectedVersion: 4 },
    ]);
  });

  it("uses a tombstone head as the CAS base when recreating a deleted remote path", async () => {
    const directory = await fixtureDirectory({ "todo.txt": "restore me\n" });
    const entries = await deriveEntries({
      directory,
      prefix: "notes",
      remoteFiles: [
        {
          path: "notes/todo.txt",
          headVersion: 2,
          hash: null,
          size: 0,
          deleted: true,
        },
      ],
    });
    assert.deepEqual(entries, [
      {
        op: "put",
        path: "notes/todo.txt",
        expectedVersion: 2,
        body: "restore me\n",
        contentType: "text/plain; charset=utf-8",
      },
    ]);
  });

  it("maps nested files with portable separators and rejects invalid prefixes", async () => {
    const directory = await fixtureDirectory({ "deep/file.txt": "ok" });
    assert.deepEqual(
      (await walkDirectory(directory)).map(({ relativePath }) => relativePath),
      ["deep/file.txt"],
    );
    await assert.rejects(
      planDirectory({ directory, prefix: "../escape" }),
      /Invalid --prefix|Invalid file path/u,
    );
    await assert.rejects(
      planDirectory({ directory, prefix: "site\\unsafe" }),
      /must use '\/' separators/u,
    );
  });
});

describe("commit-dir listing and chunks", () => {
  it("paginates every remote page and advances using the returned cursor", async () => {
    const calls = [];
    const client = emptyPageClient({
      calls,
      pages: [
        {
          files: [{ path: "site/a.txt", headVersion: 1, hash: "sha256-a", deleted: false }],
          nextAfter: "site/a.txt",
        },
        {
          files: [{ path: "site/b.txt", headVersion: 2, hash: "sha256-b", deleted: false }],
          nextAfter: null,
        },
      ],
    });
    const listed = await listRemoteHeads(client.files, "site");
    assert.deepEqual(calls, [
      { prefix: "site", includeDeleted: true },
      { prefix: "site", includeDeleted: true, after: "site/a.txt" },
    ]);
    assert.deepEqual(
      listed.map(({ path }) => path),
      ["site/a.txt", "site/b.txt"],
    );
  });

  it("rejects a failed or non-advancing list page before any write can start", async () => {
    await assert.rejects(
      listRemoteHeads(
        {
          list: async () => ({ ok: false, error: { code: "unauthorized", message: "no access" } }),
        },
        "site",
      ),
      /Listing remote files under site failed \(unauthorized\): no access/u,
    );
    await assert.rejects(
      listRemoteHeads(
        {
          list: async () => ({ ok: true, value: { files: [] } }),
        },
        "site",
      ),
      /invalid pagination cursor/u,
    );
    await assert.rejects(
      listRemoteHeads(
        {
          list: async () => ({
            ok: true,
            value: { files: [], nextAfter: "same" },
          }),
        },
        "site",
      ),
      /non-advancing cursor/u,
    );
    let page = 0;
    await assert.rejects(
      listRemoteHeads(
        {
          list: async () => {
            page += 1;
            return {
              ok: true,
              value: { files: [], nextAfter: page === 1 ? "a" : page === 2 ? "b" : "a" },
            };
          },
        },
        "site",
      ),
      /non-advancing cursor/u,
    );
  });

  it("chunks exactly at MAX_COMMIT_ENTRIES without mutating the source array", () => {
    const entries = Array.from({ length: 41 }, (_, index) => ({ path: `site/${String(index)}` }));
    const chunks = chunkEntries(entries, 20);
    assert.deepEqual(
      chunks.map((chunk) => chunk.length),
      [20, 20, 1],
    );
    assert.equal(chunks[0][0], entries[0]);
    assert.equal(entries.length, 41);
  });

  it("starts a new chunk when the aggregate decoded body budget would be exceeded", async () => {
    const directory = await fixtureDirectory({
      "a.html": "a".repeat(3_000_000),
      "b.html": "b".repeat(3_000_000),
    });
    const fixture = mutatingClient();
    await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "byte-job", "--expected-last-change-id", "9"],
      client: fixture,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir: await fixtureStateDirectory(),
    });
    assert.deepEqual(
      fixture.calls.commits.map(({ input, options }) => ({ count: input.entries.length, options })),
      [
        { count: 1, options: { idempotencyKey: "byte-job:0" } },
        { count: 1, options: { idempotencyKey: "byte-job:1" } },
      ],
    );
    assert.equal(fixture.calls.commits[0].input.entries[0].body.length, 3_000_000);
    assert.equal(fixture.calls.commits[1].input.entries[0].body.length, 3_000_000);
    assert.deepEqual(
      fixture.calls.commits.map(({ input }) => input.expectedLastChangeId),
      [9, 10],
    );
  });

  it("rejects one entry larger than the aggregate body budget before writing", async () => {
    const directory = await fixtureDirectory({
      "too-large.html": "x".repeat(MAX_COMMIT_INLINE_BYTES + 1),
    });
    const stateDir = await fixtureStateDirectory();
    const fixture = mutatingClient();
    await assert.rejects(
      runCommitDir({
        argv: [directory, "site", "demo", "--job-id", "oversized-job"],
        client: fixture,
        env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
        log: () => {},
        stateDir,
      }),
      /single entry cannot exceed 5000000 bytes/u,
    );
    assert.equal(fixture.calls.commits.length, 0);
    assert.deepEqual(await readdir(stateDir), []);
  });
});

function mutatingClient({ changeSet = false, results = [] } = {}) {
  const calls = { commits: [], changeSets: [], lists: [] };
  let resultIndex = 0;
  const create = async (input, options) => {
    const call = { input, options };
    (changeSet ? calls.changeSets : calls.commits).push(call);
    const result = results[resultIndex] ?? { ok: true, value: { id: `id-${String(resultIndex)}` } };
    resultIndex += 1;
    return result;
  };
  return {
    calls,
    files: () => ({
      async list(options) {
        calls.lists.push(options);
        return { ok: true, value: { files: [], nextAfter: null } };
      },
    }),
    commits: () => ({ create }),
    changeSets: () => ({ create }),
  };
}

describe("commit-dir mutations", () => {
  it("uses deterministic ordering and job/chunk idempotency keys", async () => {
    const directory = await fixtureDirectory(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`${String(20 - index)}.txt`, `${index}\n`]),
      ),
    );
    const stateDir = await fixtureStateDirectory();
    const fixture = mutatingClient();
    const logs = [];
    const result = await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "site-job", "--expected-last-change-id", "0"],
      client: fixture,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN, API_BASE_URL: BASE_URL },
      log: (line) => logs.push(line),
      stateDir,
    });
    assert.deepEqual(
      fixture.calls.commits.map(({ input, options }) => ({ entries: input.entries, options })),
      [
        {
          entries: fixture.calls.commits[0].input.entries,
          options: { idempotencyKey: "site-job:0" },
        },
        {
          entries: fixture.calls.commits[1].input.entries,
          options: { idempotencyKey: "site-job:1" },
        },
      ],
    );
    assert.equal(fixture.calls.commits[0].input.expectedLastChangeId, 0);
    assert.equal(fixture.calls.commits[1].input.expectedLastChangeId, 20);
    const savedState = JSON.parse(
      await readFile(join(stateDir, (await readdir(stateDir))[0]), "utf8"),
    );
    assert.deepEqual(
      savedState.chunks.map(({ input }) => input.expectedLastChangeId),
      [0, 20],
    );
    assert.deepEqual(
      fixture.calls.commits[0].input.entries.map(({ path }) => path),
      [
        "site/0.txt",
        "site/1.txt",
        "site/10.txt",
        "site/11.txt",
        "site/12.txt",
        "site/13.txt",
        "site/14.txt",
        "site/15.txt",
        "site/16.txt",
        "site/17.txt",
        "site/18.txt",
        "site/19.txt",
        "site/2.txt",
        "site/20.txt",
        "site/3.txt",
        "site/4.txt",
        "site/5.txt",
        "site/6.txt",
        "site/7.txt",
        "site/8.txt",
      ],
    );
    assert.equal(fixture.calls.commits[1].input.entries[0].path, "site/9.txt");
    assert.match(logs.join("\n"), /separately atomic.*whole directory is not one transaction/u);
    assert.equal(result.wrote, true);
  });

  it("performs no mutation for a dry run and supports change-set base versions", async () => {
    const directory = await fixtureDirectory({ "index.html": "hello" });
    const dryStateDir = await fixtureStateDirectory();
    const dry = mutatingClient();
    const dryLogs = [];
    const dryResult = await runCommitDir({
      argv: [directory, "site", "demo", "--dry-run", "--job-id", "dry-job"],
      client: dry,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: (line) => dryLogs.push(line),
      stateDir: dryStateDir,
    });
    assert.equal(dry.calls.commits.length, 0);
    assert.equal(dryResult.wrote, false);
    assert.match(dryLogs.at(-1), /no writes performed/u);

    const review = mutatingClient({ changeSet: true });
    const reviewStateDir = await fixtureStateDirectory();
    review.files = () => ({
      async list() {
        return {
          ok: true,
          value: {
            files: [
              { path: "site/index.html", headVersion: 4, hash: "sha256-old", deleted: false },
            ],
            nextAfter: null,
          },
        };
      },
    });
    await runCommitDir({
      argv: [directory, "site", "demo", "--change-set", "--job-id", "review-job"],
      client: review,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir: reviewStateDir,
    });
    assert.equal(review.calls.commits.length, 0);
    assert.equal(review.calls.changeSets.length, 1);
    assert.equal(review.calls.changeSets[0].input.entries[0].baseVersion, 4);
    assert.equal("expectedVersion" in review.calls.changeSets[0].input.entries[0], false);
  });

  it("rejects a whole-stash fence for multi-chunk change sets before persisting or writing", async () => {
    const directory = await fixtureDirectory(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`${String(index)}.txt`, `${index}\n`]),
      ),
    );
    const fixture = mutatingClient({ changeSet: true });
    const stateDir = await fixtureStateDirectory();
    await assert.rejects(
      runCommitDir({
        argv: [
          directory,
          "site",
          "demo",
          "--change-set",
          "--expected-last-change-id",
          "9",
          "--job-id",
          "change-set-fence",
        ],
        client: fixture,
        env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
        log: () => {},
        stateDir,
      }),
      /first approval would make every later chunk stale/u,
    );
    assert.equal(fixture.calls.changeSets.length, 0);
    assert.deepEqual(await readdir(stateDir), []);
  });

  it("uses byte-driven change-set chunks without a whole-stash fence", async () => {
    const directory = await fixtureDirectory({
      "a.html": "a".repeat(3_000_000),
      "b.html": "b".repeat(3_000_000),
    });
    const fixture = mutatingClient({ changeSet: true });
    await runCommitDir({
      argv: [directory, "site", "demo", "--change-set", "--job-id", "byte-change-set"],
      client: fixture,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir: await fixtureStateDirectory(),
    });
    assert.deepEqual(
      fixture.calls.changeSets.map(({ input, options }) => ({
        baseVersion: input.entries[0].baseVersion,
        bytes: input.entries[0].body.length,
        expectedLastChangeId: input.expectedLastChangeId,
        options,
      })),
      [
        {
          baseVersion: null,
          bytes: 3_000_000,
          expectedLastChangeId: undefined,
          options: { idempotencyKey: "byte-change-set:0" },
        },
        {
          baseVersion: null,
          bytes: 3_000_000,
          expectedLastChangeId: undefined,
          options: { idempotencyKey: "byte-change-set:1" },
        },
      ],
    );
  });

  it("reports replayed chunks and stops at the first failed chunk", async () => {
    const directory = await fixtureDirectory(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`${String(index)}.txt`, `${index}\n`]),
      ),
    );
    const stateDir = await fixtureStateDirectory();
    const fixture = mutatingClient({
      results: [
        { ok: true, replayed: true, value: { id: "replayed" } },
        { ok: false, error: { code: "stale", message: "head moved" } },
      ],
    });
    const logs = [];
    await assert.rejects(
      runCommitDir({
        argv: [directory, "site", "demo", "--job-id", "replay-job"],
        client: fixture,
        env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
        log: (line) => logs.push(line),
        stateDir,
      }),
      /Writing commit chunk 2\/2 failed \(stale\): head moved/u,
    );
    assert.equal(fixture.calls.commits.length, 2);
    assert.match(logs.join("\n"), /Idempotent-Replayed.*commit chunk 1\/2/u);
  });

  it("replays the exact saved chunks on a second invocation with the same job id", async () => {
    const directory = await fixtureDirectory(
      Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`${String(index)}.txt`, `${index}\n`]),
      ),
    );
    const stateDir = await fixtureStateDirectory();
    const first = mutatingClient();
    await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "saved-job"],
      client: first,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir,
    });
    const stateText = await readFile(join(stateDir, (await readdir(stateDir))[0]), "utf8");
    assert.equal(stateText.includes(ADMIN_TOKEN), false);
    const firstInputs = first.calls.commits.map(({ input, options }) => ({ input, options }));

    const second = mutatingClient({
      results: [
        { ok: true, replayed: true, value: { id: "replayed-0" } },
        { ok: true, replayed: true, value: { id: "replayed-1" } },
      ],
    });
    const logs = [];
    const result = await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "saved-job"],
      client: second,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: (line) => logs.push(line),
      stateDir,
    });
    assert.deepEqual(
      second.calls.commits.map(({ input, options }) => ({ input, options })),
      firstInputs,
    );
    assert.deepEqual(
      second.calls.commits.map(({ input }) => JSON.stringify(input)),
      first.calls.commits.map(({ input }) => JSON.stringify(input)),
    );
    assert.equal(result.wrote, true);
    assert.match(logs.join("\n"), /Idempotent-Replayed.*chunk 1\/2/u);
    assert.match(logs.join("\n"), /Idempotent-Replayed.*chunk 2\/2/u);
  });

  it("replays exact byte-driven chunks after the first invocation", async () => {
    const directory = await fixtureDirectory({
      "a.html": "a".repeat(3_000_000),
      "b.html": "b".repeat(3_000_000),
    });
    const stateDir = await fixtureStateDirectory();
    const first = mutatingClient();
    await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "byte-replay"],
      client: first,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir,
    });
    const firstInputs = first.calls.commits.map(({ input, options }) => ({ input, options }));
    const second = mutatingClient({
      results: [
        { ok: true, replayed: true, value: { id: "replayed-0" } },
        { ok: true, replayed: true, value: { id: "replayed-1" } },
      ],
    });
    await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "byte-replay"],
      client: second,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir,
    });
    assert.deepEqual(
      second.calls.commits.map(({ input, options }) => ({ input, options })),
      firstInputs,
    );
  });

  it("refuses replay when local bytes or the walked tree changes", async () => {
    const directory = await fixtureDirectory({ "index.html": "before" });
    const stateDir = await fixtureStateDirectory();
    const first = mutatingClient();
    await runCommitDir({
      argv: [directory, "site", "demo", "--job-id", "guarded-job"],
      client: first,
      env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: () => {},
      stateDir,
    });
    await writeFile(join(directory, "index.html"), "after");
    const second = mutatingClient({ results: [{ ok: true, replayed: true }] });
    await assert.rejects(
      runCommitDir({
        argv: [directory, "site", "demo", "--job-id", "guarded-job"],
        client: second,
        env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
        log: () => {},
        stateDir,
      }),
      /does not match the current directory/u,
    );
    assert.equal(second.calls.commits.length, 0);
  });

  it("keeps replay state outside the walked tree", async () => {
    const directory = await fixtureDirectory({ "index.html": "safe" });
    const fixture = mutatingClient();
    await assert.rejects(
      runCommitDir({
        argv: [directory, "site", "demo", "--job-id", "inside-job"],
        client: fixture,
        env: { STASH_WRITE_TOKEN: ADMIN_TOKEN },
        log: () => {},
        stateDir: directory,
      }),
      /Replay state must be outside the walked directory/u,
    );
    assert.equal(fixture.calls.lists.length, 0);
  });
});

describe("commit-dir option safety", () => {
  it("validates portable paths and does not put token material in action output", async () => {
    const options = readOptions(["./site", "site", "demo", "--job-id", "stable", "--dry-run"], {
      API_BASE_URL: BASE_URL,
      STASH_WRITE_TOKEN: ADMIN_TOKEN,
    });
    assert.equal(options.jobId, "stable");
    assert.throws(() => readOptions(["./site", "../bad", "demo"], {}), /Invalid --prefix/u);
    assert.throws(
      () => readOptions(["./site", "site", "demo", "--token=secret-value"], {}),
      (error) =>
        error instanceof Error &&
        !error.message.includes("secret-value") &&
        /redacted/u.test(error.message),
    );
    const directory = await fixtureDirectory({ "index.html": "safe" });
    const stateDir = await fixtureStateDirectory();
    const fixture = mutatingClient();
    const logs = [];
    await runCommitDir({
      argv: [directory, "site", "demo", "--dry-run", "--job-id", "stable"],
      client: fixture,
      env: { API_BASE_URL: BASE_URL, STASH_WRITE_TOKEN: ADMIN_TOKEN },
      log: (line) => logs.push(line),
      stateDir,
    });
    assert.equal(
      logs.some((line) => line.includes(ADMIN_TOKEN)),
      false,
    );
  });
});
