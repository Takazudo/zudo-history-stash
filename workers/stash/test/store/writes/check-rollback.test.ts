import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createWrites } from "../../../src/d1/writes.js";
import { counts, setup } from "./helpers.js";

function omitHeadWrite(statements: D1PreparedStatement[]): D1PreparedStatement[] {
  return statements.filter((_, index) => index !== statements.length - 3);
}

async function commitCount(stash: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM commits WHERE stash_name = ?")
    .bind(stash)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

describe("single-path write CHECK rollback", () => {
  it("rolls back a put when its head write is missing", async () => {
    const { stash, writes } = await setup({
      alterWriteStatementsForTest: omitHeadWrite,
    });
    const before = await counts(stash);
    const commitsBefore = await commitCount(stash);

    const result = await writes.put(
      stash,
      "put.txt",
      { body: "put body", expectedVersion: null },
      { idempotencyKey: "forced-put" },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal",
        status: 500,
        message: "Put batch failed without a competing write",
      },
    });
    expect(await counts(stash)).toEqual(before);
    expect(await commitCount(stash)).toBe(commitsBefore);
  });

  it("rolls back a delete when its head write is missing", async () => {
    const initial = await setup();
    const seeded = await initial.writes.put(initial.stash, "delete.txt", {
      body: "delete body",
      expectedVersion: null,
    });
    if (!seeded.ok || "unchanged" in seeded.value) throw new Error("Expected delete fixture");
    const writes = createWrites(initial.env, {
      ...initial.deps,
      alterWriteStatementsForTest: omitHeadWrite,
    });
    const before = await counts(initial.stash);
    const commitsBefore = await commitCount(initial.stash);

    const result = await writes.delete(
      initial.stash,
      "delete.txt",
      { expectedVersion: 1 },
      { idempotencyKey: "forced-delete" },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "internal",
        status: 500,
        message: "Delete batch failed without a competing write",
      },
    });
    expect(await counts(initial.stash)).toEqual(before);
    expect(await commitCount(initial.stash)).toBe(commitsBefore);
  });
});
