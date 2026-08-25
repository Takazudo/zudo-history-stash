import { describe, expect, it } from "vitest";
import { defaultPathForPrincipal, isSafeNext } from "./safe-next.js";

describe("isSafeNext", () => {
  it.each(["/", "/s/example", "/s/example/f/a.txt?version=2#body"])(
    "accepts same-origin application path %s",
    (next) => expect(isSafeNext(next)).toBe(true),
  );

  it.each([
    null,
    "",
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
  ])("rejects unsafe target %s", (next) => expect(isSafeNext(next)).toBe(false));

  it("uses principal-specific defaults", () => {
    expect(defaultPathForPrincipal({ principal: "admin" })).toBe("/");
    expect(defaultPathForPrincipal({ principal: "stash", stash: "notes" })).toBe("/s/notes");
  });
});
