import { describe, expect, it } from "vitest";
import { isWellFormedString, utf8ByteLength } from "./hash.js";
import { joinPath, pathPrefixRange, validatePath, validateStashName } from "./paths.js";

describe("validatePath", () => {
  it.each(["..", ".", "a//b", "/a", "a/", "a/%2F", "a/日本語", "a".repeat(513)])(
    "rejects %j",
    (path) => expect(validatePath(path).ok).toBe(false),
  );
  it("accepts the contract grammar", () => expect(validatePath("a/b.c-d_e")).toEqual({ ok: true }));
  it("joins without changing bytes", () => expect(joinPath("a", "b.c-d_e")).toBe("a/b.c-d_e"));
});

describe("validateStashName", () => {
  it.each(["a", "a-1", "0", "a".repeat(63)])("accepts %j", (name) => {
    expect(validateStashName(name).ok).toBe(true);
  });
  it.each(["", "A", "-a", "a_1", "a".repeat(64)])("rejects %j", (name) => {
    expect(validateStashName(name).ok).toBe(false);
  });
});

describe("pathPrefixRange", () => {
  it("returns no range for an undefined prefix", () => {
    expect(pathPrefixRange(undefined)).toEqual({ ok: true, range: null });
  });

  it.each([
    ["site", { ok: true, range: { lo: "site/", hi: "site0" } }],
    ["site/", { ok: true, range: { lo: "site/", hi: "site0" } }],
    ["a/b", { ok: true, range: { lo: "a/b/", hi: "a/b0" } }],
  ])("normalizes %j", (prefix, expected) => {
    expect(pathPrefixRange(prefix)).toEqual(expected);
  });

  it.each(["", "/", ".."])("rejects %j", (prefix) => {
    expect(pathPrefixRange(prefix)).toEqual({
      ok: false,
      error: "invalid-path",
      message: "Invalid file path",
    });
  });

  it("uses an exclusive upper bound after the slash", () => {
    const result = pathPrefixRange("site");
    expect(result).toEqual({ ok: true, range: { lo: "site/", hi: "site0" } });
    if (!result.ok || result.range === null) throw new Error("Expected a path range");

    const paths = ["site/index.html", "site/x/y.md", "site2/a.md", "sit/a.md", "siteX"];
    expect(paths.filter((path) => path >= result.range.lo && path < result.range.hi)).toEqual([
      "site/index.html",
      "site/x/y.md",
    ]);
    expect(paths.filter((path) => path < result.range.lo || path >= result.range.hi)).toEqual([
      "site2/a.md",
      "sit/a.md",
      "siteX",
    ]);
  });
});

describe("UTF-8 helpers", () => {
  it("counts CJK bytes", () => expect(utf8ByteLength("日本語")).toBe(9));
  it("detects lone surrogates", () => expect(isWellFormedString("\uD800")).toBe(false));
});
