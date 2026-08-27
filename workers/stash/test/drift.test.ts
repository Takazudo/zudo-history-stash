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

function sectionVars(source: string, section: string): Record<string, string> {
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionSource =
    source.match(new RegExp(`\\[${escapedSection}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? "";
  return Object.fromEntries(
    Array.from(sectionSource.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/gm), (match) => [
      match[1],
      match[2],
    ]),
  );
}

describe("Wrangler and Env drift", () => {
  it("declares every source binding in Wrangler and Env", () => {
    const source = Object.values(sourceModules).join("\n");
    const references = matches(source, /\b(?:c\.)?env\.([A-Z][A-Z0-9_]*)/g);
    const bindings = matches(wranglerSource, /\bbinding\s*=\s*"([A-Z][A-Z0-9_]*)"/g);
    const rateLimits = matches(
      wranglerSource,
      /^\[\[(?:env\.[^.]+\.)?ratelimits\]\]\s*\n\s*name\s*=\s*"([A-Z][A-Z0-9_]*)"/gm,
    );
    const vars = matches(wranglerSource, /^([A-Z][A-Z0-9_]*)\s*=\s*"/gm);
    const secrets = matches(wranglerSource, /"([A-Z][A-Z0-9_]*)"/g);
    const envKeys = matches(envSource, /^\s*([A-Z][A-Z0-9_]*):/gm);
    const configured = new Set([...bindings, ...rateLimits, ...vars, ...secrets]);

    expect([...references].sort()).toEqual([
      "ALLOWED_ORIGINS",
      "BLOBS",
      "DB",
      "GC_LEASE_TTL_MS",
      "GC_ORPHAN_MIN_AGE_MS",
      "RL_DIFF",
      "RL_READ",
      "RL_WRITE",
      "STASH_ADMIN_TOKEN",
    ]);
    for (const name of references) {
      expect(configured.has(name), `${name} missing from wrangler.toml`).toBe(true);
      expect(envKeys.has(name), `${name} missing from Env`).toBe(true);
    }
  });

  it("pins separate production and preview R2 buckets", () => {
    const buckets = Array.from(
      wranglerSource.matchAll(
        /^\[\[((?:env\.preview\.)?r2_buckets)\]\]\s*\n\s*binding\s*=\s*"([^"]+)"\s*\n\s*bucket_name\s*=\s*"([^"]+)"/gm,
      ),
      (match) => ({ section: match[1], binding: match[2], bucketName: match[3] }),
    );

    expect(buckets).toEqual([
      {
        section: "r2_buckets",
        binding: "BLOBS",
        bucketName: "zudo-history-stash-blobs",
      },
      {
        section: "env.preview.r2_buckets",
        binding: "BLOBS",
        bucketName: "zudo-history-stash-blobs-preview",
      },
    ]);
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

  it("pins lifecycle variables in production and preview without scheduling or paid limits", () => {
    const expected = {
      STASH_DELETE_GRACE_DAYS: "30",
      GC_ORPHAN_MIN_AGE_MS: "900000",
      GC_LEASE_TTL_MS: "300000",
    };
    expect(sectionVars(wranglerSource, "vars")).toEqual({
      ALLOWED_ORIGINS: "",
      ...expected,
    });
    expect(sectionVars(wranglerSource, "env.preview.vars")).toEqual({
      ALLOWED_ORIGINS: "http://localhost:5173",
      ...expected,
    });

    const envKeys = matches(envSource, /^\s*([A-Z][A-Z0-9_]*):/gm);
    for (const name of Object.keys(expected)) expect(envKeys.has(name)).toBe(true);
    expect(wranglerSource).not.toMatch(/\b(?:triggers|crons|subrequests)\b/i);
  });
});
