import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_SUPPORTED_ROUTE_IDS,
  CONFORMANCE_TRACE,
  runConformance,
} from "./conformance.trace.js";
import { createFakeStash } from "../../src/testing/index.js";

describe("shared conformance trace", () => {
  it("passes the complete data-driven sequence against the fake", async () => {
    const fake = createFakeStash({
      adminToken: "conformance-admin",
      now: () => Date.parse("2026-08-25T00:00:00.000Z"),
    });

    const report = await runConformance(fake.fetch, "https://fake.invalid", {
      adminToken: "conformance-admin",
      stashName: "conformance-test",
    });

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
        "stash token may get its own stash",
        "read scope cannot write",
        "foreign stash is concealed",
        "create file",
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
        "token revocation returns an empty 204",
        "revoked token fails authentication",
        "token list reports revocation without exposing secrets",
      ]),
    );
  });
});
