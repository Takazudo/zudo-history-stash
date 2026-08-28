import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkContract, ContractCheckError } from "./check-contract.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REFERENCE_ROOT = resolve(REPOSITORY_ROOT, "doc/src/content/docs/reference");
const CORE_PATH = resolve(REPOSITORY_ROOT, "packages/core/dist/index.js");
const OPENAPI_PATH = resolve(REPOSITORY_ROOT, "docs/openapi.json");
const core = await import(pathToFileURL(CORE_PATH).href);
const canonicalOpenApi = JSON.parse(await readFile(OPENAPI_PATH, "utf8"));

async function fixture(t, locale = "en") {
  const root = await mkdtemp(join(tmpdir(), "zhs-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contentRoot = join(root, "content");
  await cp(REFERENCE_ROOT, join(contentRoot, "reference"), { recursive: true });
  return {
    root,
    options: {
      repositoryRoot: REPOSITORY_ROOT,
      locales: [locale],
      contentRoots: { [locale]: contentRoot },
      core,
      openApi: structuredClone(canonicalOpenApi),
    },
    reference(path) {
      return join(contentRoot, "reference", path);
    },
  };
}

async function mutate(path, transform) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  assert.notEqual(next, source, `mutation did not change ${path}`);
  await writeFile(path, next);
}

async function expectDiagnostic(options, pattern) {
  await assert.rejects(
    checkContract(options),
    (error) =>
      error instanceof ContractCheckError &&
      error.diagnostics.some((diagnostic) => pattern.test(diagnostic)),
  );
}

test("production English reference matches fresh Core and OpenAPI contracts", async () => {
  assert.deepEqual(await checkContract({ repositoryRoot: REPOSITORY_ROOT }), {
    routes: 31,
    errors: 21,
    limits: 17,
    locales: ["en"],
  });
});

test("the reference inventory rejects a missing or unexpected page", async (t) => {
  await t.test("missing", async (t) => {
    const value = await fixture(t);
    await rm(value.reference("architecture.mdx"));
    await expectDiagnostic(value.options, /missing reference page architecture\.mdx/);
  });

  await t.test("unexpected", async (t) => {
    const value = await fixture(t);
    await writeFile(
      value.reference("untracked.mdx"),
      "---\ntitle: Untracked\ndescription: Untracked.\n---\n",
    );
    await expectDiagnostic(value.options, /unexpected reference page untracked\.mdx/);
  });
});

test("route discovery rejects omissions, duplicates, method drift, and internal notation", async (t) => {
  await t.test("missing route", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/health-and-identity.mdx"), (source) =>
      source.replace(/### `GET \/v1\/health`[\s\S]*?(?=### `GET \/v1\/me`)/, ""),
    );
    await expectDiagnostic(value.options, /missing route GET \/v1\/health/);
  });

  await t.test("duplicate route in another owner", async (t) => {
    const value = await fixture(t);
    await mutate(
      value.reference("http-api/stashes.mdx"),
      (source) =>
        `${source}\n### \`GET /v1/health\`\n\n**Contract:** operation \`health\`; principal \`open\`; transport \`any\`.\n`,
    );
    await expectDiagnostic(value.options, /duplicate route GET \/v1\/health/);
  });

  await t.test("route hidden in an MDX comment", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/health-and-identity.mdx"), (source) =>
      source.replace(/(### `GET \/v1\/health`[\s\S]*?)(?=### `GET \/v1\/me`)/, "{/*\n$1*/}\n\n"),
    );
    await expectDiagnostic(value.options, /missing route GET \/v1\/health/);
  });

  await t.test("same-path diff method drift", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/files-history-and-diffs.mdx"), (source) =>
      source.replace(
        "### `POST /v1/stashes/{stash}/diff/{path}`",
        "### `GET /v1/stashes/{stash}/diff/{path}`",
      ),
    );
    await expectDiagnostic(
      value.options,
      /missing route POST \/v1\/stashes\/\{stash\}\/diff\/\{path\}/,
    );
  });

  await t.test("internal Core notation in public docs", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/files-history-and-diffs.mdx"), (source) =>
      source.replace(
        "### `GET /v1/stashes/{stash}/files/{path}`",
        "### `GET /v1/stashes/:stash/files/*path`",
      ),
    );
    await expectDiagnostic(value.options, /uses internal parameter notation/);
  });
});

test("route metadata rejects independent id, principal, transport, and owner drift", async (t) => {
  for (const [name, from, to, diagnostic] of [
    ["id", "operation `health`", "operation `healthWrong`", /id must be health/],
    ["principal", "principal `open`", "principal `admin`", /principal must be open/],
    ["transport", "transport `any`", "transport `fetch-only`", /transport must be any/],
  ]) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.reference("http-api/health-and-identity.mdx"), (source) =>
        source.replace(from, to),
      );
      await expectDiagnostic(value.options, diagnostic);
    });
  }

  await t.test("wrong owner", async (t) => {
    const value = await fixture(t);
    const healthPath = value.reference("http-api/health-and-identity.mdx");
    const health = await readFile(healthPath, "utf8");
    const section = /### `GET \/v1\/health`[\s\S]*?(?=### `GET \/v1\/me`)/.exec(health)?.[0];
    assert.ok(section);
    await writeFile(healthPath, health.replace(section, ""));
    await mutate(value.reference("http-api/stashes.mdx"), (source) => `${source}\n${section}`);
    await expectDiagnostic(
      value.options,
      /operation health owner must be http-api\/health-and-identity\.mdx/,
    );
  });

  await t.test("duplicate operation id on another route", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/health-and-identity.mdx"), (source) =>
      source.replace("operation `me`", "operation `health`"),
    );
    await expectDiagnostic(value.options, /duplicate operation id health/);
  });

  await t.test("malformed metadata", async (t) => {
    const value = await fixture(t);
    await mutate(value.reference("http-api/health-and-identity.mdx"), (source) =>
      source.replace(
        "**Contract:** operation `health`; principal `open`; transport `any`.",
        "**Contract:** operation `health`, principal `open`, transport `any`.",
      ),
    );
    await expectDiagnostic(value.options, /route GET \/v1\/health has malformed Contract metadata/);
  });
});

test("route discovery fails closed when all operation headings disappear", async (t) => {
  const value = await fixture(t);
  for (const owner of [
    "http-api/change-feeds.mdx",
    "http-api/files-history-and-diffs.mdx",
    "http-api/garbage-collection.mdx",
    "http-api/health-and-identity.mdx",
    "http-api/import.mdx",
    "http-api/live-events.mdx",
    "http-api/proposals.mdx",
    "http-api/stashes.mdx",
    "http-api/tokens.mdx",
  ]) {
    await mutate(value.reference(owner), (source) => source.replaceAll("### `", "#### `"));
  }
  await expectDiagnostic(value.options, /en: discovered zero MDX operations/);
});

test("OpenAPI drift is detected independently", async (t) => {
  await t.test("missing operation", async (t) => {
    const value = await fixture(t);
    delete value.options.openApi.paths["/v1/health"].get;
    await expectDiagnostic(value.options, /openapi: missing route GET \/v1\/health/);
  });

  await t.test("principal mismatch", async (t) => {
    const value = await fixture(t);
    value.options.openApi.paths["/v1/health"].get["x-principal"] = "admin";
    await expectDiagnostic(value.options, /openapi: GET \/v1\/health principal must be open/);
  });

  await t.test("operation id mismatch", async (t) => {
    const value = await fixture(t);
    value.options.openApi.paths["/v1/health"].get.operationId = "healthWrong";
    await expectDiagnostic(value.options, /openapi: GET \/v1\/health id must be health/);
  });
});

test("error rows are exact pairs in the dedicated visible section", async (t) => {
  for (const [name, transform, diagnostic] of [
    [
      "missing",
      (source) => source.replace(/^\| `stale` .*\n/m, "The word `stale` remains in prose.\n"),
      /missing error row stale/,
    ],
    [
      "duplicate",
      (source) => source.replace(/(\| `stale` .*\n)/, "$1$1"),
      /duplicate error row stale/,
    ],
    [
      "status",
      (source) =>
        source.replace(
          "| `idempotency-key-reused` | `422` |",
          "| `idempotency-key-reused` | `409` |",
        ),
      /error idempotency-key-reused value must be 422/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.reference("error-codes.mdx"), transform);
      await expectDiagnostic(value.options, diagnostic);
    });
  }
});

test("limit rows preserve names, shared values, and exact decimals", async (t) => {
  for (const [name, transform, diagnostic] of [
    [
      "missing shared-value name",
      (source) => source.replace(/^\| `R2_SPILL_BYTES` .*\n/m, ""),
      /missing limit row R2_SPILL_BYTES/,
    ],
    [
      "duplicate",
      (source) => source.replace(/(\| `MAX_PATH_BYTES` .*\n)/, "$1$1"),
      /duplicate limit row MAX_PATH_BYTES/,
    ],
    [
      "value",
      (source) =>
        source.replace("| `DIFF_TIMEOUT_MS` | `2000` |", "| `DIFF_TIMEOUT_MS` | `2001` |"),
      /limit DIFF_TIMEOUT_MS value must be 2000/,
    ],
    [
      "encoded-body decimal",
      (source) =>
        source.replace("| `BODY_LIMIT_BYTES` | `33554432` |", "| `BODY_LIMIT_BYTES` | `32` |"),
      /limit BODY_LIMIT_BYTES value must be 33554432/,
    ],
  ]) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.reference("limits.mdx"), transform);
      await expectDiagnostic(value.options, diagnostic);
    });
  }
});

test("missing, malformed, and non-contract Core dist fail with a build instruction", async (t) => {
  const value = await fixture(t);
  delete value.options.core;
  delete value.options.openApi;
  value.options.openApiPath = OPENAPI_PATH;

  await assert.rejects(
    checkContract({ ...value.options, coreModulePath: join(value.root, "missing-core.mjs") }),
    /pnpm build:libs/,
  );

  const malformed = join(value.root, "malformed-core.mjs");
  await writeFile(malformed, "this is not JavaScript");
  await assert.rejects(
    checkContract({ ...value.options, coreModulePath: malformed }),
    /pnpm build:libs/,
  );

  const empty = join(value.root, "empty-core.mjs");
  await writeFile(empty, "export const unrelated = true;\n");
  await assert.rejects(
    checkContract({ ...value.options, coreModulePath: empty }),
    /pnpm build:libs/,
  );
});

test("non-finite public numeric exports fail closed", async (t) => {
  const value = await fixture(t);
  value.options.core = { ...core, SENTINEL_NONFINITE: Number.POSITIVE_INFINITY };
  await expectDiagnostic(value.options, /numeric export SENTINEL_NONFINITE must be finite/);
});

test("the locale-neutral parser accepts a synthetic Japanese reference root", async (t) => {
  const value = await fixture(t, "ja");
  assert.deepEqual(await checkContract(value.options), {
    routes: 31,
    errors: 21,
    limits: 17,
    locales: ["ja"],
  });
});
