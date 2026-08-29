import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  CONFORMANCE_TRACE,
  runConformance,
} from "./conformance.trace.js";
import { createFakeStash } from "../../src/testing/index.js";

const ADMIN = "conformance-admin";

function createConformanceHarness(stashName: string) {
  let now = Date.parse("2026-08-25T00:00:00.000Z");
  const denied = new Set<string>();
  const fake = createFakeStash({
    adminToken: ADMIN,
    now: () => now,
    rateLimit: ({ capability, key }) => ({
      success: !denied.has(`${capability}:${key}`),
    }),
  });
  return {
    fake,
    options: {
      adminToken: ADMIN,
      stashName,
      advanceTime(milliseconds: number) {
        now += milliseconds;
      },
      configureRateLimit({ capability, key }: { capability: string; key: string }) {
        denied.add(`${capability}:${key}`);
      },
    },
  };
}

async function stashPage(fake: ReturnType<typeof createFakeStash>, after: string) {
  const response = await fake.fetch(
    `https://fake.invalid/v1/stashes?limit=1&after=${encodeURIComponent(after)}`,
    { headers: { Authorization: `Bearer ${ADMIN}` } },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ stashes: Array<{ name: string }>; nextAfter: string | null }>;
}

describe("shared conformance trace", () => {
  it("passes the complete data-driven sequence against the fake", async () => {
    const { fake, options } = createConformanceHarness("conformance-test");
    const report = await runConformance(fake.fetch, "https://fake.invalid", options);

    expect(report.steps).toBe(CONFORMANCE_TRACE.length);
    expect(new Set(report.exercisedRouteIds)).toEqual(new Set(CONFORMANCE_SUPPORTED_ROUTE_IDS));
    expect(CONFORMANCE_TRACE.map((step) => step.name)).toHaveLength(
      new Set(CONFORMANCE_TRACE.map((step) => step.name)).size,
    );
    expect(CONFORMANCE_TRACE.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        "stash list exposes a keyset continuation",
        "get stash returns its aggregate",
        "create read token returns its secret once",
        "token list is newest first and omits secrets",
        "expiring token is usable before its boundary",
        "expired token is concealed as unauthorized",
        "rotation creates one successor and truncates predecessor grace",
        "rotation retry names the one successor",
        "rotation successor authenticates with inherited expiry",
        "stash token may get its own stash",
        "read scope cannot write",
        "foreign stash is concealed",
        "create file",
        "events replay the committed change through ready",
        "idempotency key reuse is rejected",
        "CAS precedes skip-if-unchanged",
        "weak comma-list ETag returns 304",
        "unchanged write does not append",
        "delete claims the key skipped by unchanged",
        "delete replay preserves original 200 status",
        "create-only remains exists on a tombstoned path",
        "deleting a matching tombstone reports already-deleted",
        "put resurrects a tombstoned head",
        "rollback to tombstone is rejected",
        "rollback appends a new version",
        "identical rollback still appends",
        "old put replay wins after the head moved",
        "history is newest-first and paged",
        "changes since cursor is ascending",
        "changes before cursor continues backward",
        "stored diff reports same content across versions",
        "stored diff treats a tombstone as empty",
        "stored diff truncates unified output at line boundaries",
        "candidate diff reports oversized bytes",
        "file list rejects an excessive limit",
        "configured write-principal limit returns retry metadata",
        "token revocation returns an empty 204",
        "revoked token fails authentication",
        "token list reports revocation without exposing secrets",
        "create foreign probe token",
        "delete conceals the live stash and revokes its tokens",
        "deleted stash remains visible only through explicit admin get",
        "default stash list conceals a deleted stash",
        "includeDeleted stash list exposes a deleted stash",
        "deleted stash normal routes are concealed even for admin",
        "former stash token is revoked after deletion",
        "foreign token probing a deleted stash is concealed",
        "restore returns the original stash without its old tokens",
        "restored stash does not revive its former token",
        "restored stash name is never recycled",
        "GC dry run returns a private-safe page",
        "GC run history is newest first and never exposes R2 keys",
        "ledger GC dry run has its own stable job kind",
        "ledger GC history can be filtered by kind",
      ]),
    );
    const terminalPage = await stashPage(fake, "conformance-test-foreign");
    expect(terminalPage.stashes.map(({ name }) => name)).toEqual(["conformance-test-later"]);
    expect(terminalPage.nextAfter).toBeNull();
  });

  it("passes when its known later row has a persisted continuation", async () => {
    const stashName = "conformance-later-only";
    const { fake, options } = createConformanceHarness(stashName);
    fake.createStash("zzzz-existing");

    const report = await runConformance(fake.fetch, "https://fake.invalid", options);

    expect(report.steps).toBe(CONFORMANCE_TRACE.length);
    const persistedPage = await stashPage(fake, `${stashName}-foreign`);
    expect(persistedPage.stashes.map(({ name }) => name)).toEqual([`${stashName}-later`]);
    expect(persistedPage.nextAfter).toBe(`${stashName}-later`);
  });

  it("passes with a persisted stash interleaved between its fixtures", async () => {
    const stashName = "conformance-interleaved";
    const { fake, options } = createConformanceHarness(stashName);
    fake.createStash(`${stashName}-between`);

    const report = await runConformance(fake.fetch, "https://fake.invalid", options);

    expect(report.steps).toBe(CONFORMANCE_TRACE.length);
    const terminalPage = await stashPage(fake, `${stashName}-foreign`);
    expect(terminalPage.stashes.map(({ name }) => name)).toEqual([`${stashName}-later`]);
    expect(terminalPage.nextAfter).toBeNull();
  });
});
