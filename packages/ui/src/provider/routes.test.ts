import { describe, expect, it } from "vitest";
import { defaultStashHref } from "./routes.js";

describe("defaultStashHref", () => {
  it("serializes the viewer route contract", () => {
    expect(defaultStashHref({ kind: "home" })).toBe("/");
    expect(defaultStashHref({ kind: "stash", stash: "team notes" })).toBe("/s/team%20notes");
    expect(
      defaultStashHref({
        kind: "file",
        stash: "notes",
        path: "docs/日本語.txt",
        version: 3,
      }),
    ).toBe("/s/notes/f/docs/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt?version=3");
    expect(
      defaultStashHref({
        kind: "diff",
        stash: "notes",
        path: "readme.md",
        from: 2,
        to: "head",
        context: 5,
      }),
    ).toBe("/s/notes/diff/readme.md?from=2&to=head&context=5");
    expect(defaultStashHref({ kind: "edit", stash: "notes", path: "readme.md", from: 2 })).toBe(
      "/s/notes/edit/readme.md?from=2",
    );
    expect(defaultStashHref({ kind: "new-file", stash: "notes" })).toBe("/s/notes/new");
    expect(defaultStashHref({ kind: "tokens", stash: "notes" })).toBe("/s/notes/tokens");
    expect(defaultStashHref({ kind: "commits", stash: "notes" })).toBe("/s/notes/commits");
    expect(defaultStashHref({ kind: "commit", stash: "notes", id: "cmt /1" })).toBe(
      "/s/notes/commits/cmt%20%2F1",
    );
    expect(defaultStashHref({ kind: "change-sets", stash: "notes" })).toBe("/s/notes/change-sets");
    expect(defaultStashHref({ kind: "change-set", stash: "notes", id: "chs/1" })).toBe(
      "/s/notes/change-sets/chs%2F1",
    );
  });
});
