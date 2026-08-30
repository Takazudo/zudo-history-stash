import { describe, expect, it } from "vitest";
import envSource from "../src/env.ts?raw";
import generatedEnvSource from "../worker-configuration.d.ts?raw";
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
      "CHANGE_SET_TTL_DAYS",
      "DB",
      "GC_CONTENT_MIN_AGE_MS",
      "GC_LEASE_TTL_MS",
      "GC_ORPHAN_MIN_AGE_MS",
      "RL_DIFF",
      "RL_READ",
      "RL_WRITE",
      "STASH_ADMIN_TOKEN",
      "STASH_DELETE_GRACE_DAYS",
      "STASH_EVENTS",
      "STASH_EVENTS_MAX_STREAM_MS",
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

  it("pins lifecycle and binary variables in both environments without paid limits", () => {
    const expected = {
      STASH_DELETE_GRACE_DAYS: "30",
      GC_ORPHAN_MIN_AGE_MS: "900000",
      GC_CONTENT_MIN_AGE_MS: "86400000",
      GC_CHANGE_SET_RETENTION_MS: "2592000000",
      GC_LEASE_TTL_MS: "300000",
      CHANGE_SET_TTL_DAYS: "14",
      STASH_EVENTS_MAX_STREAM_MS: "300000",
      JSON_INLINE_MAX_BYTES: "5000000",
      D1_INLINE_MAX_BYTES: "524288",
      HTTP_REQUEST_MAX_BYTES: "100000000",
      SINGLE_UPLOAD_MAX_BYTES: "33554432",
      MAX_FILE_BYTES: "100000000",
      DIFF_MAX_BYTES: "524288",
      MULTIPART_PART_BYTES: "8388608",
      MAX_OPEN_UPLOAD_SESSIONS: "8",
      MAX_RESERVED_UPLOAD_BYTES: "500000000",
      UPLOAD_SESSION_TTL_SECONDS: "86400",
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
    expect(wranglerSource).toContain('[triggers]\ncrons = ["17 3 * * *"]');
    expect(wranglerSource).toContain("[env.preview.triggers]\ncrons = []");
    expect(wranglerSource).not.toMatch(/\bsubrequests\b/i);
  });

  it("pins the StashEvents binding, migration, and generated types in both environments", () => {
    const bindings = Array.from(
      wranglerSource.matchAll(
        /^\[\[((?:env\.preview\.)?durable_objects\.bindings)\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nclass_name\s*=\s*"([^"]+)"/gm,
      ),
      (match) => ({ section: match[1], name: match[2], className: match[3] }),
    );
    expect(bindings).toEqual([
      { section: "durable_objects.bindings", name: "STASH_EVENTS", className: "StashEvents" },
      {
        section: "env.preview.durable_objects.bindings",
        name: "STASH_EVENTS",
        className: "StashEvents",
      },
    ]);

    const migrations = Array.from(
      wranglerSource.matchAll(
        /^\[\[((?:env\.preview\.)?migrations)\]\]\s*\ntag\s*=\s*"([^"]+)"\s*\nnew_sqlite_classes\s*=\s*\["([^"]+)"\]/gm,
      ),
      (match) => ({ section: match[1], tag: match[2], className: match[3] }),
    );
    expect(migrations).toEqual([
      { section: "migrations", tag: "v1", className: "StashEvents" },
      { section: "env.preview.migrations", tag: "v1", className: "StashEvents" },
    ]);

    expect(generatedEnvSource).toMatch(/STASH_EVENTS: DurableObjectNamespace<[^>]*StashEvents>/);
    expect(generatedEnvSource).toContain('STASH_EVENTS_MAX_STREAM_MS: "300000"');
  });
});
