import { createTestEnv } from "./env.js";

export const READ_FIXTURE_STASH = "reads-fixture";

export async function seedCommit(
  stash: string,
  id: string,
  createdAt = 1,
  source: "put" | "delete" | "rollback" | "import" | "upload" = "put",
): Promise<string> {
  await createTestEnv()
    .env.DB.prepare(
      `INSERT INTO commits
         (id, stash_name, source, entry_count, created_by, created_at)
       VALUES (?, ?, ?, 1, 'test-fixture', ?)`,
    )
    .bind(id, stash, source, createdAt)
    .run();
  return id;
}

const HASH_ALPHA_ONE = "sha256-alpha-one";
const HASH_ALPHA_TWO = "sha256-alpha-two";
const HASH_BETA_ONE = "sha256-beta-one";
const HASH_BETA_TWO = "sha256-beta-two";
const HASH_GAMMA_ONE = "sha256-gamma-one";

/**
 * Seed the read-side fixture through SQL only.  Keeping this independent from
 * the write store lets the read tests run while the write implementation is
 * developed in parallel.
 */
export async function seedReadRows(): Promise<void> {
  const db = createTestEnv().env.DB;
  await db
    .prepare("INSERT INTO stashes (name, description, meta_json, created_at) VALUES (?, ?, ?, ?)")
    .bind(READ_FIXTURE_STASH, "read fixture", '{"fixture":true}', 1_700_000_000_000)
    .run();

  const blobs = [
    [READ_FIXTURE_STASH, HASH_ALPHA_ONE, "alpha v1\n", null, 9, 1_700_000_000_010],
    [READ_FIXTURE_STASH, HASH_ALPHA_TWO, "alpha v2\n", null, 9, 1_700_000_000_020],
    [READ_FIXTURE_STASH, HASH_BETA_ONE, "beta v1\n", null, 8, 1_700_000_000_040],
    [READ_FIXTURE_STASH, HASH_BETA_TWO, "beta v2\n", null, 8, 1_700_000_000_050],
    [READ_FIXTURE_STASH, HASH_GAMMA_ONE, "gamma v1\n", null, 9, 1_700_000_000_070],
  ] as const;
  for (const blob of blobs) {
    await db
      .prepare(
        "INSERT INTO blobs (stash_name, hash, body, r2_key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(...blob)
      .run();
  }

  const versions = [
    [
      1,
      READ_FIXTURE_STASH,
      "alpha.txt",
      1,
      "put",
      HASH_ALPHA_ONE,
      9,
      "text/plain; charset=utf-8",
      null,
      "alice",
      "alpha first",
      '{"step":1}',
      1_700_000_000_011,
    ],
    [
      2,
      READ_FIXTURE_STASH,
      "alpha.txt",
      2,
      "put",
      HASH_ALPHA_TWO,
      9,
      "text/markdown",
      null,
      "bob",
      "alpha second",
      '{"step":2}',
      1_700_000_000_021,
    ],
    [
      3,
      READ_FIXTURE_STASH,
      "alpha.txt",
      3,
      "delete",
      null,
      0,
      "text/markdown",
      null,
      "carol",
      "remove alpha",
      '{"step":3}',
      1_700_000_000_031,
    ],
    [
      4,
      READ_FIXTURE_STASH,
      "beta.txt",
      1,
      "put",
      HASH_BETA_ONE,
      8,
      "text/plain; charset=utf-8",
      null,
      "alice",
      "beta first",
      '{"step":1}',
      1_700_000_000_041,
    ],
    [
      5,
      READ_FIXTURE_STASH,
      "beta.txt",
      2,
      "put",
      HASH_BETA_TWO,
      8,
      "text/plain; charset=utf-8",
      null,
      "bob",
      "beta second",
      '{"step":2}',
      1_700_000_000_051,
    ],
    [
      6,
      READ_FIXTURE_STASH,
      "beta.txt",
      3,
      "rollback",
      HASH_BETA_ONE,
      8,
      "text/plain; charset=utf-8",
      1,
      "carol",
      "restore beta first",
      '{"step":3,"rollback":true}',
      1_700_000_000_061,
    ],
    [
      7,
      READ_FIXTURE_STASH,
      "gamma.txt",
      1,
      "put",
      HASH_GAMMA_ONE,
      9,
      "text/plain; charset=utf-8",
      null,
      "dave",
      "gamma first",
      '{"step":1}',
      1_700_000_000_071,
    ],
  ] as const;
  for (const version of versions) {
    const commitId = await seedCommit(
      READ_FIXTURE_STASH,
      `cmt_fixture_${version[0]}`,
      version[12],
      version[4],
    );
    await db
      .prepare(
        `INSERT INTO versions (
          id, stash_name, path, version, kind, blob_hash, size_bytes, content_type,
          rollback_of, author, message, meta_json, created_at, commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...version, commitId)
      .run();
  }

  const files = [
    [READ_FIXTURE_STASH, "alpha.txt", 3, null, 1, 1_700_000_000_011, 1_700_000_000_031],
    [READ_FIXTURE_STASH, "beta.txt", 3, HASH_BETA_ONE, 0, 1_700_000_000_041, 1_700_000_000_061],
    [READ_FIXTURE_STASH, "gamma.txt", 1, HASH_GAMMA_ONE, 0, 1_700_000_000_071, 1_700_000_000_071],
  ] as const;
  for (const file of files) {
    await db
      .prepare(
        `INSERT INTO files (
          stash_name, path, head_version, head_hash, deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...file)
      .run();
  }
}
