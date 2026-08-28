import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  PREVIEW_RATE_LIMIT_BASE,
  createPreviewConfig,
  generatePreviewConfigs,
  normalizePrNumber,
  normalizeViewerOrigin,
} from "./preview-config.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(REPOSITORY_ROOT, "scripts/fixtures/preview");
const FIXTURE_STASH = resolve(FIXTURES, "stash.toml");
const FIXTURE_VIEWER = resolve(FIXTURES, "viewer.toml");
const REAL_STASH = resolve(REPOSITORY_ROOT, "workers/stash/wrangler.toml");
const REAL_VIEWER = resolve(REPOSITORY_ROOT, "workers/viewer/wrangler.toml");
const D1_ID = "00000000-0000-4000-8000-000000000012";
const VIEWER_ORIGIN = "https://zudo-history-stash-viewer-pr-12.example.workers.dev";

const scratchDirectories = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createScratch() {
  const directory = await mkdtemp(resolve(tmpdir(), "zhs-preview-config-"));
  scratchDirectories.push(directory);
  return directory;
}

async function readToml(path) {
  return parse(await readFile(path, "utf8"));
}

function resolvedConfigPath(configPath, value) {
  return resolve(dirname(configPath), value);
}

async function generateFixture(pr, outDir) {
  return generatePreviewConfigs({
    pr,
    d1Id: D1_ID,
    viewerOrigin: VIEWER_ORIGIN,
    outDir: outDir ?? (await createScratch()),
    stashConfigPath: FIXTURE_STASH,
    viewerConfigPath: FIXTURE_VIEWER,
  });
}

describe("preview config fixture transformation", () => {
  it("flattens env.preview and applies every PR-specific binding for PR 12", async () => {
    const result = await generateFixture(12);
    const stash = await readToml(result.stashConfigPath);
    const viewer = await readToml(result.viewerConfigPath);

    assert.equal(stash.name, "zudo-history-stash-pr-12");
    assert.equal(stash.compatibility_date, "2026-08-25");
    assert.equal(stash.workers_dev, true);
    assert.deepEqual(stash.observability, { enabled: true });
    assert.deepEqual(stash.triggers, { crons: [] });
    assert.equal("routes" in stash, false);
    assert.equal("env" in stash, false);
    assert.equal("preview_urls" in stash, false);

    assert.deepEqual(stash.vars, {
      ALLOWED_ORIGINS: VIEWER_ORIGIN,
      SOURCE: "preview",
    });
    assert.deepEqual(stash.secrets, { required: ["PREVIEW_SECRET"] });
    assert.deepEqual(stash.durable_objects, {
      bindings: [{ name: "STASH_EVENTS", class_name: "FixtureEvents" }],
    });
    assert.deepEqual(stash.migrations, [{ tag: "v1", new_sqlite_classes: ["FixtureEvents"] }]);

    assert.equal(stash.d1_databases.length, 1);
    assert.equal(stash.d1_databases[0].binding, "DB");
    assert.equal(stash.d1_databases[0].database_name, "zudo-history-stash-pr-12");
    assert.equal(stash.d1_databases[0].database_id, D1_ID);
    assert.equal(
      resolvedConfigPath(result.stashConfigPath, stash.d1_databases[0].migrations_dir),
      resolve(FIXTURES, "fixture-migrations"),
    );
    assert.deepEqual(stash.r2_buckets, [
      { binding: "BLOBS", bucket_name: "zudo-history-stash-blobs-pr-12" },
    ]);
    assert.deepEqual(
      stash.ratelimits.map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })),
      [
        { name: "RL_READ", namespace_id: "2000120", simple: { limit: 600, period: 60 } },
        { name: "RL_WRITE", namespace_id: "2000121", simple: { limit: 60, period: 60 } },
        { name: "RL_DIFF", namespace_id: "2000122", simple: { limit: 120, period: 60 } },
      ],
    );

    assert.equal(
      resolvedConfigPath(result.stashConfigPath, stash.main),
      resolve(FIXTURES, "fixture-src/stash.ts"),
    );
    assert.equal(viewer.name, "zudo-history-stash-viewer-pr-12");
    assert.equal(viewer.workers_dev, true);
    assert.deepEqual(viewer.triggers, { crons: [] });
    assert.deepEqual(viewer.vars, { SOURCE: "preview" });
    assert.deepEqual(viewer.services, [{ binding: "STASH", service: "zudo-history-stash-pr-12" }]);
    assert.equal("routes" in viewer, false);
    assert.equal("env" in viewer, false);
    assert.equal("preview_urls" in viewer, false);
    assert.equal(
      resolvedConfigPath(result.viewerConfigPath, viewer.main),
      resolve(FIXTURES, "fixture-src/viewer.ts"),
    );
    assert.equal(
      resolvedConfigPath(result.viewerConfigPath, viewer.assets.directory),
      resolve(FIXTURES, "fixture-assets"),
    );
  });

  it("is byte-deterministic and allocates disjoint exact IDs for PR 12 and PR 13", async () => {
    const out12 = await createScratch();
    const first = await generateFixture(12, out12);
    const firstStash = await readFile(first.stashConfigPath, "utf8");
    const firstViewer = await readFile(first.viewerConfigPath, "utf8");
    await generateFixture(12, out12);
    assert.equal(await readFile(first.stashConfigPath, "utf8"), firstStash);
    assert.equal(await readFile(first.viewerConfigPath, "utf8"), firstViewer);

    const result13 = await generateFixture(13);
    const stash12 = parse(firstStash);
    const stash13 = await readToml(result13.stashConfigPath);
    const ids12 = stash12.ratelimits.map(({ namespace_id }) => namespace_id);
    const ids13 = stash13.ratelimits.map(({ namespace_id }) => namespace_id);
    assert.deepEqual(ids12, ["2000120", "2000121", "2000122"]);
    assert.deepEqual(ids13, ["2000130", "2000131", "2000132"]);
    assert.equal(new Set(ids12).size, ids12.length);
    assert.equal(new Set(ids13).size, ids13.length);
    assert.equal(
      ids12.some((id) => ids13.includes(id)),
      false,
    );

    const fixtureSource = await readToml(FIXTURE_STASH);
    const committedSource = await readToml(REAL_STASH);
    const committedIds = [
      ...fixtureSource.ratelimits,
      ...fixtureSource.env.preview.ratelimits,
      ...committedSource.ratelimits,
      ...committedSource.env.preview.ratelimits,
    ].map(({ namespace_id }) => namespace_id);
    assert.equal(
      [...ids12, ...ids13].some((id) => committedIds.includes(id)),
      false,
    );
  });

  it("rejects an eleventh binding that would collide with the next PR allocation", async () => {
    const source = await readToml(FIXTURE_STASH);
    const outputConfigPath = resolve(await createScratch(), "stash.toml");
    const template = source.env.preview.ratelimits[0];
    source.env.preview.ratelimits = Array.from({ length: 11 }, (_, index) => ({
      ...template,
      name: `RL_${index}`,
    }));

    assert.equal(PREVIEW_RATE_LIMIT_BASE + 12 * 10 + 10, PREVIEW_RATE_LIMIT_BASE + 13 * 10);
    assert.throws(
      () =>
        createPreviewConfig({
          source,
          sourceConfigPath: FIXTURE_STASH,
          outputConfigPath,
          kind: "stash",
          pr: 12,
          d1Id: D1_ID,
          viewerOrigin: VIEWER_ORIGIN,
        }),
      /cannot exceed the 10-ID per-PR preview allocation/,
    );
  });

  it("rejects an unknown top-level table instead of silently dropping it", async () => {
    const sourceConfigPath = resolve(FIXTURES, "unknown-table.toml");
    const outputConfigPath = resolve(await createScratch(), "stash.toml");
    const source = await readFile(sourceConfigPath, "utf8");
    assert.throws(
      () =>
        createPreviewConfig({
          source,
          sourceConfigPath,
          outputConfigPath,
          kind: "stash",
          pr: 12,
          d1Id: D1_ID,
          viewerOrigin: VIEWER_ORIGIN,
        }),
      /top level: unsupported table "unsupported_binding"/,
    );
  });

  it("rejects an unknown env.preview table instead of silently dropping it", async () => {
    const sourceConfigPath = resolve(FIXTURES, "unknown-preview-table.toml");
    const outputConfigPath = resolve(await createScratch(), "stash.toml");
    const source = await readFile(sourceConfigPath, "utf8");
    assert.throws(
      () =>
        createPreviewConfig({
          source,
          sourceConfigPath,
          outputConfigPath,
          kind: "stash",
          pr: 12,
          d1Id: D1_ID,
          viewerOrigin: VIEWER_ORIGIN,
        }),
      /env\.preview: unsupported table "queues"/,
    );
  });
});

describe("committed Wrangler config drift", () => {
  it("generates complete deployable shapes from the real env.preview tables", async () => {
    const outDir = await createScratch();
    const result = await generatePreviewConfigs({
      pr: 12,
      d1Id: D1_ID,
      viewerOrigin: `${VIEWER_ORIGIN}/`,
      outDir,
      stashConfigPath: REAL_STASH,
      viewerConfigPath: REAL_VIEWER,
    });
    const stash = await readToml(result.stashConfigPath);
    const viewer = await readToml(result.viewerConfigPath);

    assert.deepEqual(Object.keys(stash).sort(), [
      "compatibility_date",
      "d1_databases",
      "durable_objects",
      "main",
      "migrations",
      "name",
      "observability",
      "r2_buckets",
      "ratelimits",
      "secrets",
      "triggers",
      "vars",
      "workers_dev",
    ]);
    assert.equal(stash.name, "zudo-history-stash-pr-12");
    assert.equal(stash.workers_dev, true);
    assert.deepEqual(stash.triggers, { crons: [] });
    assert.deepEqual(stash.observability, { enabled: true });
    assert.equal(
      resolvedConfigPath(result.stashConfigPath, stash.main),
      resolve(dirname(REAL_STASH), "src/index.ts"),
    );
    assert.deepEqual(stash.vars, {
      ALLOWED_ORIGINS: VIEWER_ORIGIN,
      STASH_DELETE_GRACE_DAYS: "30",
      GC_ORPHAN_MIN_AGE_MS: "900000",
      GC_LEASE_TTL_MS: "300000",
      PROPOSAL_TTL_DAYS: "14",
      STASH_EVENTS_MAX_STREAM_MS: "300000",
    });
    assert.deepEqual(stash.secrets, { required: ["STASH_ADMIN_TOKEN"] });
    assert.deepEqual(stash.durable_objects, {
      bindings: [{ name: "STASH_EVENTS", class_name: "StashEvents" }],
    });
    assert.deepEqual(stash.migrations, [{ tag: "v1", new_sqlite_classes: ["StashEvents"] }]);
    assert.equal(stash.d1_databases[0].database_name, "zudo-history-stash-pr-12");
    assert.equal(stash.d1_databases[0].database_id, D1_ID);
    assert.equal(
      resolvedConfigPath(result.stashConfigPath, stash.d1_databases[0].migrations_dir),
      resolve(dirname(REAL_STASH), "migrations"),
    );
    assert.deepEqual(stash.r2_buckets, [
      { binding: "BLOBS", bucket_name: "zudo-history-stash-blobs-pr-12" },
    ]);
    assert.deepEqual(
      stash.ratelimits.map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })),
      [
        { name: "RL_READ", namespace_id: "2000120", simple: { limit: 600, period: 60 } },
        { name: "RL_WRITE", namespace_id: "2000121", simple: { limit: 60, period: 60 } },
        { name: "RL_DIFF", namespace_id: "2000122", simple: { limit: 120, period: 60 } },
      ],
    );

    assert.deepEqual(Object.keys(viewer).sort(), [
      "assets",
      "compatibility_date",
      "main",
      "name",
      "observability",
      "services",
      "triggers",
      "workers_dev",
    ]);
    assert.equal(viewer.name, "zudo-history-stash-viewer-pr-12");
    assert.equal(viewer.workers_dev, true);
    assert.deepEqual(viewer.triggers, { crons: [] });
    assert.deepEqual(viewer.services, [{ binding: "STASH", service: "zudo-history-stash-pr-12" }]);
    assert.equal(
      resolvedConfigPath(result.viewerConfigPath, viewer.main),
      resolve(dirname(REAL_VIEWER), "src/worker.ts"),
    );
    assert.equal(
      resolvedConfigPath(result.viewerConfigPath, viewer.assets.directory),
      resolve(dirname(REAL_VIEWER), "dist"),
    );
    assert.equal("vars" in viewer, false);
    assert.equal("env" in viewer, false);
    assert.equal("routes" in viewer, false);
  });
});

describe("CLI value validation", () => {
  it("accepts only positive PR numbers and canonical HTTP(S) origins", () => {
    assert.equal(normalizePrNumber("12"), 12);
    assert.throws(() => normalizePrNumber("0"), /positive safe integer/);
    assert.throws(() => normalizePrNumber("1.5"), /positive safe integer/);
    assert.throws(() => normalizePrNumber(Number.MAX_SAFE_INTEGER), /positive safe integer/);
    assert.equal(normalizeViewerOrigin(`${VIEWER_ORIGIN}/`), VIEWER_ORIGIN);
    assert.throws(() => normalizeViewerOrigin(`${VIEWER_ORIGIN}/path`), /without a path/);
    assert.throws(() => normalizeViewerOrigin("ftp://example.com"), /HTTP\(S\) origin/);
  });

  it("rejects a PR whose final rate-limit binding would exceed the safe-integer range", async () => {
    const pr = Math.floor((Number.MAX_SAFE_INTEGER - PREVIEW_RATE_LIMIT_BASE) / 10);
    assert.equal(normalizePrNumber(pr), pr);
    const source = await readFile(FIXTURE_STASH, "utf8");
    const outputConfigPath = resolve(await createScratch(), "stash.toml");
    assert.throws(
      () =>
        createPreviewConfig({
          source,
          sourceConfigPath: FIXTURE_STASH,
          outputConfigPath,
          kind: "stash",
          pr,
          d1Id: D1_ID,
          viewerOrigin: VIEWER_ORIGIN,
        }),
      /unsafe rate-limit namespace allocation/,
    );
  });
});
