import { describe, expect, it } from "vitest";
import { mintToken } from "../src/auth.js";

describe("mintToken", () => {
  it("mints opaque IDs and 256-bit base64url secrets", () => {
    const first = mintToken();
    const second = mintToken();
    expect(first.id).toMatch(/^tok_[0-9a-f]{32}$/);
    expect(first.token).toMatch(/^zhs_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toEqual(first);
  });
});
