import { describe, expect, it } from "vitest";
import { canonicalJson, requestHashInput } from "./canonical.js";
import { formatEtag, ifNoneMatchMatches } from "./etag.js";

describe("ETags", () => {
  it("formats live and tombstone representations", () => {
    expect(formatEtag({ version: 2, hash: "sha256-abc", deleted: false })).toBe('"v2-sha256-abc"');
    expect(formatEtag({ version: 3, hash: null, deleted: true })).toBe('"v3-deleted"');
  });
  it.each([
    ['W/"v2-sha256-old", "v3-sha256-new"', '"v3-sha256-new"', true],
    ["*", '"v3-sha256-new"', true],
    ['"v2-sha256-old"', '"v3-sha256-new"', false],
    [null, '"v3-sha256-new"', false],
  ])("matches lists and weak tags", (header, etag, expected) => {
    expect(ifNoneMatchMatches(header, etag)).toBe(expected);
  });
});

describe("canonical request input", () => {
  it("sorts nested object keys without whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
  it("makes key order irrelevant and meaningful defaults distinct", () => {
    const one = requestHashInput("put", { path: "a", expectedVersion: 1, meta: { z: 1, a: 2 } });
    const two = requestHashInput("put", { meta: { a: 2, z: 1 }, expectedVersion: 1, path: "a" });
    expect(canonicalJson(one)).toBe(canonicalJson(two));
    expect(
      canonicalJson(
        requestHashInput("put", { path: "a", expectedVersion: 1, skipIfUnchanged: true }),
      ),
    ).not.toBe(canonicalJson(one));
    expect(
      canonicalJson(
        requestHashInput("put", { path: "a", expectedVersion: 1, contentType: "text/markdown" }),
      ),
    ).not.toBe(canonicalJson(one));
  });
});
