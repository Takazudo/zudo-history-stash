import { describe, expect, it } from "vitest";
import { createStashClient } from "../../src/index.js";
import { createFakeStash } from "../../src/testing/index.js";
import { GOLDEN_NOW, GOLDEN_RESPONSES } from "./fixtures/golden-responses.js";

describe("client golden response parity", () => {
  it("returns the shared put, file, conflict, delete, and tombstone shapes", async () => {
    const fake = createFakeStash({ adminToken: "golden-admin", now: () => GOLDEN_NOW });
    fake.createStash("golden");
    let key = 0;
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "golden-admin",
      fetch: fake.fetch,
      idempotencyKey: () => `golden-${(key += 1)}`,
    });
    const files = client.files("golden");

    await expect(
      files.put("docs/readme.md", {
        body: "hello",
        expectedVersion: null,
        author: "fixture",
        message: "golden",
        meta: { nested: { b: 2, a: 1 } },
      }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.put });

    await expect(files.get("docs/readme.md")).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.file,
    });

    await expect(
      files.put("docs/readme.md", { body: "changed", expectedVersion: 99 }),
    ).resolves.toEqual(GOLDEN_RESPONSES.stale);

    await expect(
      files.delete("docs/readme.md", { expectedVersion: 1, message: "removed" }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.deleted });

    await expect(files.get("docs/readme.md", { version: 2 })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tombstone,
    });
  });
});
