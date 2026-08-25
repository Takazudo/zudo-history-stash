import { describe, expect, it } from "vitest";
import envSource from "../src/env.ts?raw";
import wranglerSource from "../wrangler.toml?raw";

const sourceModules = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function matches(source: string, pattern: RegExp): Set<string> {
  const values = Array.from(source.matchAll(pattern), (match) => match[1]);
  return new Set(values.filter((value): value is string => value !== undefined));
}

describe("Wrangler and Env drift", () => {
  it("declares every source binding in Wrangler and Env", () => {
    const source = Object.values(sourceModules).join("\n");
    const references = matches(source, /\b(?:c\.)?env\.([A-Z][A-Z0-9_]*)/g);
    const bindings = matches(wranglerSource, /\bbinding\s*=\s*"([A-Z][A-Z0-9_]*)"/g);
    const vars = matches(wranglerSource, /^([A-Z][A-Z0-9_]*)\s*=\s*"/gm);
    const secrets = matches(wranglerSource, /"([A-Z][A-Z0-9_]*)"/g);
    const envKeys = matches(envSource, /^\s*([A-Z][A-Z0-9_]*):/gm);
    const configured = new Set([...bindings, ...vars, ...secrets]);

    expect([...references].sort()).toEqual(["ALLOWED_ORIGINS", "DB", "STASH_ADMIN_TOKEN"]);
    for (const name of references) {
      expect(configured.has(name), `${name} missing from wrangler.toml`).toBe(true);
      expect(envKeys.has(name), `${name} missing from Env`).toBe(true);
    }
  });

  it("keeps used required secrets in Env", () => {
    const source = Object.values(sourceModules).join("\n");
    const references = matches(source, /\b(?:c\.)?env\.([A-Z][A-Z0-9_]*)/g);
    const envKeys = matches(envSource, /^\s*([A-Z][A-Z0-9_]*):/gm);
    const required = new Set(
      Array.from(wranglerSource.matchAll(/required\s*=\s*\[([^\]]*)\]/g)).flatMap((match) =>
        Array.from((match[1] ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/g), (item) => item[1]).filter(
          (value): value is string => value !== undefined,
        ),
      ),
    );
    for (const name of required) {
      if (references.has(name)) expect(envKeys.has(name)).toBe(true);
    }
  });
});
