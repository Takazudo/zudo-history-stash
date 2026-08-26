import assert from "node:assert/strict";
import test from "node:test";
import { lintRawPxText } from "./lint-raw-px.mjs";

test("rejects raw px values outside the border and outline exceptions", () => {
  const violations = lintRawPxText(
    "fixture.css",
    ".bad { padding: 8px; width: 1px; border-radius: 2px; transform: translateX(-2px); }",
  );

  assert.deepEqual(
    violations.map(({ property, value }) => ({ property, value })),
    [
      { property: "padding", value: "8px" },
      { property: "width", value: "1px" },
      { property: "border-radius", value: "2px" },
      { property: "transform", value: "-2px" },
    ],
  );
});

test("allows one and two px border and outline declarations", () => {
  const violations = lintRawPxText(
    "fixture.css",
    ".ok { border: 1px solid currentColor; border-inline-width: 2px; border-block-start: 1px solid currentColor; outline: 2px solid currentColor; outline-offset: 2px; }",
  );

  assert.deepEqual(violations, []);
});

test("ignores px examples in CSS comments", () => {
  assert.deepEqual(
    lintRawPxText("fixture.css", "/* padding: 8px; */\n.ok { border: 1px solid; }"),
    [],
  );
});
