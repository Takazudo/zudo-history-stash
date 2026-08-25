import { describe, expect, it } from "vitest";
import { isWellFormedString, utf8ByteLength } from "./hash.js";
import { joinPath, validatePath, validateStashName } from "./paths.js";

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

describe("UTF-8 helpers", () => {
  it("counts CJK bytes", () => expect(utf8ByteLength("日本語")).toBe(9));
  it("detects lone surrogates", () => expect(isWellFormedString("\uD800")).toBe(false));
});
