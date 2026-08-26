import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/relocated.css"), "utf8");

function declarationsFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{(?<declarations>[^}]*)\\}`, "u"));
  return match?.groups?.declarations ?? "";
}

describe("relocated component CSS", () => {
  it("keeps path cells in copy-safe code typography", () => {
    const pathCell = declarationsFor(".zhs-path-cell");

    expect(pathCell).toContain("font-family: var(--font-family-mono)");
    expect(pathCell).toContain("line-height: var(--line-code)");
    expect(css).toMatch(
      /\.zhs-path-cell,\s*\.zhs-change-row__path\s*\{[^}]*overflow-wrap:\s*break-word/u,
    );
    expect(css).not.toMatch(/\.zhs-path-cell[^}]*word-break:\s*break-all/u);
  });
});
