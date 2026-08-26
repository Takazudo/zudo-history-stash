import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/stateful.css"), "utf8");

describe("relocated stateful CSS contract", () => {
  it("keeps every class package-prefixed and every color tokenized", () => {
    const classes = [...css.matchAll(/\.([_a-zA-Z][-_a-zA-Z0-9]*)/gu)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(40);
    expect(classes.every((className) => className?.startsWith("zhs-"))).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\brgba?\(/u);
  });

  it("pins dense tables, copy-safe wrapping, hover capability, and CSS-owned dialog scrolling", () => {
    expect(css).toContain("block-size: var(--row-dense)");
    expect(css).toContain("min-block-size: var(--control-height)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toContain("word-break: break-all");
    expect(css).toContain("@media (hover: hover)");
    expect(css).toMatch(
      /\.zhs-diff-table--split\s+\.zhs-table__body\s+\.zhs-table__row:hover\s+> \.zhs-diff-table__cell--void\s*\{[^}]*background-color: var\(--theme-diff-context-bg\);[^}]*background-image: repeating-linear-gradient\(/su,
    );
    expect(css).toMatch(
      /\.zhs-diff-table--split\s+\.zhs-table__body\s+\.zhs-table__row:hover\s+> \.zhs-diff-table__cell--removed\s*\{[^}]*background: var\(--theme-diff-remove-bg\);/su,
    );
    expect(css).toMatch(
      /\.zhs-diff-table--split\s+\.zhs-table__body\s+\.zhs-table__row:hover\s+> \.zhs-diff-table__cell--added\s*\{[^}]*background: var\(--theme-diff-add-bg\);/su,
    );
    expect(css).toMatch(
      /\.zhs-rollback-dialog__preview\s*\{[^}]*max-block-size: 40dvh;[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/su,
    );
    expect(css).toMatch(/\.zhs-diff-table__col--gutter\s*\{[^}]*inline-size: 5ch;/su);
    expect(css).toMatch(/\.zhs-diff-table__col--sign\s*\{[^}]*inline-size: 2\.5ch;/su);
  });
});
