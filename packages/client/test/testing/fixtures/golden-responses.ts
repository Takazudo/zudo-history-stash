export const GOLDEN_NOW = Date.parse("2026-08-25T00:00:00.000Z");
export const GOLDEN_CREATED_AT = "2026-08-25T00:00:00.000Z";
export const GOLDEN_HELLO_HASH =
  "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

export const GOLDEN_RESPONSES = {
  put: {
    version: 1,
    hash: GOLDEN_HELLO_HASH,
    size: 5,
    changeId: 1,
    createdAt: GOLDEN_CREATED_AT,
  },
  file: {
    path: "docs/readme.md",
    version: 1,
    hash: GOLDEN_HELLO_HASH,
    size: 5,
    kind: "put",
    author: "fixture",
    message: "golden",
    meta: { nested: { a: 1, b: 2 } },
    createdAt: GOLDEN_CREATED_AT,
    deleted: false,
    body: "hello",
    etag: `"v1-${GOLDEN_HELLO_HASH}"`,
  },
  stale: {
    ok: false,
    error: { code: "stale", message: "Expected version is stale", status: 409 },
    current: {
      version: 1,
      hash: GOLDEN_HELLO_HASH,
      deleted: false,
      kind: "put",
      author: "fixture",
      createdAt: GOLDEN_CREATED_AT,
    },
  },
  deleted: {
    version: 2,
    changeId: 2,
    createdAt: GOLDEN_CREATED_AT,
  },
  tombstone: {
    path: "docs/readme.md",
    version: 2,
    hash: null,
    size: 0,
    kind: "delete",
    author: "",
    message: "removed",
    meta: {},
    createdAt: GOLDEN_CREATED_AT,
    deleted: true,
    body: null,
    etag: '"v2-deleted"',
  },
} as const;
