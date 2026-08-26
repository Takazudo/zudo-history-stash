import { describe, expect, it } from "vitest";
import { createStashClient } from "../../src/index.js";
import { createFakeStash } from "../../src/testing/index.js";
import { GOLDEN_NOW, GOLDEN_RESPONSES } from "./fixtures/golden-responses.js";

describe("client golden response parity", () => {
  it("returns deterministic stash and token administration contracts", async () => {
    const fake = createFakeStash({ adminToken: "golden-admin-token", now: () => GOLDEN_NOW });
    const admin = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "golden-admin-token",
      fetch: fake.fetch,
    });

    await expect(
      admin.stashes.create({
        name: "golden-admin",
        description: "Golden admin fixture",
        meta: { owner: "viewer" },
      }),
    ).resolves.toEqual({ ok: true, value: GOLDEN_RESPONSES.stash });
    await expect(admin.stashes.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.stashList,
    });
    await expect(admin.stashes.get("golden-admin")).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.stash,
    });

    const tokens = admin.stashes.tokens("golden-admin");
    await expect(tokens.create({ label: "Reader", scope: "read" })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.readToken,
    });
    await expect(tokens.create({ label: "Writer", scope: "write" })).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.writeToken,
    });
    await expect(tokens.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tokenList,
    });

    const reader = createStashClient({
      baseUrl: "https://fake.invalid",
      token: GOLDEN_RESPONSES.readToken.token,
      fetch: fake.fetch,
    });
    const writer = createStashClient({
      baseUrl: "https://fake.invalid",
      token: GOLDEN_RESPONSES.writeToken.token,
      fetch: fake.fetch,
    });
    await expect(reader.me()).resolves.toEqual({
      ok: true,
      value: {
        principal: "stash",
        stash: "golden-admin",
        tokenId: GOLDEN_RESPONSES.readToken.id,
        scope: "read",
      },
    });
    await expect(writer.me()).resolves.toEqual({
      ok: true,
      value: {
        principal: "stash",
        stash: "golden-admin",
        tokenId: GOLDEN_RESPONSES.writeToken.id,
        scope: "write",
      },
    });
    await expect(tokens.revoke(GOLDEN_RESPONSES.readToken.id)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(reader.me()).resolves.toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "A valid bearer token is required.",
        status: 401,
      },
    });
    await expect(tokens.list()).resolves.toEqual({
      ok: true,
      value: GOLDEN_RESPONSES.tokenListAfterUseAndRevoke,
    });
  });

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
