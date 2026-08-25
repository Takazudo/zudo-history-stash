import { createStashClient } from "@takazudo/zudo-history-stash";
import { describe, expect, it } from "vitest";
import { API_BASE_URL, SEEDED_PATH, SEEDED_STASH, TEST_TIER } from "./env.js";
import { createAdminClient, unwrap } from "./helpers.js";

describe(`read-only HTTP contract (${TEST_TIER}: ${API_BASE_URL})`, () => {
  it("returns the public health marker", async () => {
    const anonymous = createStashClient({ baseUrl: API_BASE_URL });
    const health = unwrap(await anonymous.health(), "health");
    expect(health).toEqual({
      ok: true,
      service: "zudo-history-stash",
      marker: "ZHS_HEALTH_OK",
    });
  });

  it("identifies the configured credential as the administrator", async () => {
    const me = unwrap(await createAdminClient().me(), "me");
    expect(me).toEqual({ principal: "admin" });
  });

  it("lists stashes and gets the seeded stash", async () => {
    const client = createAdminClient();
    const page = unwrap(await client.stashes.list({ limit: 200 }), "list stashes");
    expect(Array.isArray(page.stashes)).toBe(true);
    expect(page.nextAfter === null || typeof page.nextAfter === "string").toBe(true);

    const stash = unwrap(await client.stashes.get(SEEDED_STASH), "get seeded stash");
    expect(stash.name).toBe(SEEDED_STASH);
    expect(stash.fileCount).toBeGreaterThan(0);
    expect(stash.lastChangeId).not.toBeNull();
  });

  it("lists and conditionally reads the seeded file", async () => {
    const files = createAdminClient().files(SEEDED_STASH);
    const page = unwrap(await files.list({ includeDeleted: true, limit: 200 }), "list files");
    expect(page.files.some(({ path }) => path === SEEDED_PATH)).toBe(true);

    const first = await files.get(SEEDED_PATH);
    if (!first.ok || "notModified" in first) throw new Error("seeded file was not readable");
    expect(first.value.path).toBe(SEEDED_PATH);
    expect(first.value.deleted).toBe(false);
    expect(first.value.body).toEqual(expect.any(String));
    expect(first.value.etag).toMatch(/^"v\d+-sha256-[a-f0-9]{64}"$/u);

    const cached = await files.get(SEEDED_PATH, { ifNoneMatch: first.value.etag });
    expect(cached).toEqual({ ok: true, notModified: true });
  });

  it("returns newest-first history and a stored diff for the seeded file", async () => {
    const files = createAdminClient().files(SEEDED_STASH);
    const history = unwrap(await files.history(SEEDED_PATH, { limit: 200 }), "seeded file history");
    expect(history.path).toBe(SEEDED_PATH);
    expect(history.versions.length).toBeGreaterThanOrEqual(4);
    expect(history.versions[0]?.version).toBe(history.headVersion);
    expect(history.versions.some(({ kind }) => kind === "rollback")).toBe(true);

    const diff = unwrap(await files.diff(SEEDED_PATH, { from: 1, to: 2 }), "seeded file diff");
    expect(diff.from.version).toBe(1);
    expect(diff.to.version).toBe(2);
    expect(diff.state).toBe("ready");
    if (diff.state === "ready") {
      expect(diff.hunks.length).toBeGreaterThan(0);
      expect(diff.stats.added + diff.stats.removed).toBeGreaterThan(0);
    }
  });

  it("computes a read-capability candidate diff without persisting", async () => {
    const files = createAdminClient().files(SEEDED_STASH);
    const head = await files.get(SEEDED_PATH);
    if (!head.ok || "notModified" in head || head.value.body === null) {
      throw new Error("seeded file head was not live");
    }

    // This POST route is intentionally read-only: candidate bodies are diffed in memory only.
    const candidate = unwrap(
      await files.diffCandidate(SEEDED_PATH, { from: "head", body: head.value.body }),
      "candidate diff",
    );
    expect(candidate).toEqual({ state: "same" });
  });

  it("returns admin and per-stash change feeds", async () => {
    const client = createAdminClient();
    const adminChanges = unwrap(await client.changes({ limit: 200 }), "admin changes");
    expect(Array.isArray(adminChanges.changes)).toBe(true);
    expect(adminChanges.hasMore).toEqual(expect.any(Boolean));

    const stashChanges = unwrap(
      await client.files(SEEDED_STASH).changes({ limit: 200 }),
      "stash changes",
    );
    expect(stashChanges.changes.length).toBeGreaterThan(0);
    expect(stashChanges.changes.every(({ stash }) => stash === SEEDED_STASH)).toBe(true);
  });

  it("rejects list limits above 200 rather than clamping them", async () => {
    const result = await createAdminClient().files(SEEDED_STASH).list({ limit: 201 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("limit 201 unexpectedly succeeded");
    expect(result.error).toMatchObject({ status: 400, code: "validation" });
  });
});
