import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const contract = readFileSync(resolve(process.cwd(), "../../docs/design-tokens.md"), "utf8");
const index = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

function namesIn(source: string): string[] {
  return [...source.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmu)].map((match) => match[1]!);
}

function referencesIn(source: string): string[] {
  return [...source.matchAll(/var\((--[a-z0-9-]+)/gmu)].map((match) => match[1]!);
}

describe("the Viewer design-token contract", () => {
  it("keeps the host reset below package components in the cascade", () => {
    expect(tokens).toContain("@layer base, zhs-components, utilities;");
    expect(tokens).toContain('@import "tailwindcss/preflight" layer(base);');
    expect(tokens).toContain('@import "tailwindcss/utilities" layer(utilities);');
  });

  it("prefers dark UA chrome before the stylesheet establishes the theme", () => {
    expect(index).toContain('<meta name="color-scheme" content="dark light" />');
  });

  it("documents every public token declared from tier 2 onward", () => {
    const publicStart = tokens.indexOf("/* Tier 2:");
    const publicEnd = tokens.indexOf("/* No stored preference");
    expect(publicStart).toBeGreaterThan(-1);
    expect(publicEnd).toBeGreaterThan(publicStart);

    const undocumented = namesIn(tokens.slice(publicStart, publicEnd)).filter(
      (name) => !contract.includes(`\`${name}\``),
    );
    expect(undocumented).toEqual([]);
  });

  it("keeps tier 3 free of raw colors and palette dependencies", () => {
    const tier3Start = tokens.indexOf("/* Tier 3:");
    const tier3End = tokens.indexOf("/* Type:", tier3Start);
    const tier3 = tokens.slice(tier3Start, tier3End);
    const undocumented = [...new Set([...namesIn(tier3), ...referencesIn(tier3)])].filter(
      (name) => !contract.includes(`\`${name}\``),
    );

    expect(undocumented).toEqual([]);
    expect(tier3).not.toMatch(/:\s*(?:#[\da-f]{3,8}|rgba?\(|oklch\(|transparent\s*;)/iu);
    expect(tier3).not.toContain("var(--palette-");
  });
});
