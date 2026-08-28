import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkExamples, ExampleCheckError } from "./check-examples.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_PATHS = {
  "@takazudo/zudo-history-stash": [resolve(REPOSITORY_ROOT, "packages/client/dist/index.d.ts")],
  "@takazudo/zudo-history-stash/testing": [
    resolve(REPOSITORY_ROOT, "packages/client/dist/testing/index.d.ts"),
  ],
  "@takazudo/zudo-history-stash-core": [resolve(REPOSITORY_ROOT, "packages/core/dist/index.d.ts")],
  "@takazudo/zudo-history-stash-core/openapi": [
    resolve(REPOSITORY_ROOT, "packages/core/dist/openapi/index.d.ts"),
  ],
  "@takazudo/zudo-history-stash-ui": [resolve(REPOSITORY_ROOT, "packages/ui/dist/index.d.ts")],
};

function mdx(id, language, code, between = "\n") {
  return `---
title: Fixture
description: Fixture.
sidebar_position: 1
category: reference
---

{/* zhs-example: ${id} */}${between}\`\`\`${language}
${code}\`\`\`
`;
}

function manifest(entries) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      snippets: Object.fromEntries(
        Object.entries(entries)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, source]) => [id, { source }]),
      ),
    },
    null,
    2,
  )}\n`;
}

async function fixture(t, { withJapanese = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zhs-examples-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const en = join(root, "content-en");
  const ja = join(root, "content-ja");
  const examplesRoot = join(root, "examples");
  await mkdir(en, { recursive: true });
  await mkdir(examplesRoot, { recursive: true });
  const id = "reference-fixture";
  const sourceName = `${id}.ts`;
  const source = "export const fixtureValue = 42;\n";
  await writeFile(join(en, "fixture.mdx"), mdx(id, "ts", source));
  await writeFile(join(examplesRoot, sourceName), source);
  if (withJapanese) {
    await mkdir(ja, { recursive: true });
    await writeFile(join(ja, "fixture.mdx"), mdx(id, "ts", source));
  }
  const manifestPath = join(examplesRoot, "manifest.json");
  const tsconfigPath = join(root, "tsconfig.json");
  await writeFile(manifestPath, manifest({ [id]: sourceName }));
  await writeFile(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          baseUrl: REPOSITORY_ROOT,
          paths: REQUIRED_PATHS,
          types: [],
        },
        include: ["./examples/**/*.ts", "./examples/**/*.tsx"],
      },
      null,
      2,
    )}\n`,
  );
  return {
    root,
    en,
    ja,
    examplesRoot,
    manifestPath,
    tsconfigPath,
    id,
    source,
    sourceName,
    options: {
      repositoryRoot: REPOSITORY_ROOT,
      contentRoots: withJapanese ? { en, ja } : { en },
      locales: withJapanese ? ["en", "ja"] : ["en"],
      examplesRoot,
      manifestPath,
      tsconfigPath,
    },
  };
}

async function expectDiagnostic(options, pattern) {
  await assert.rejects(
    checkExamples(options),
    (error) =>
      error instanceof ExampleCheckError &&
      error.diagnostics.some((diagnostic) => pattern.test(diagnostic)),
  );
}

test("production examples map every formatter-clean fence to public-dist TypeScript", async () => {
  const examplesRoot = resolve(REPOSITORY_ROOT, "doc/examples-check");
  const productionManifest = JSON.parse(
    await readFile(resolve(examplesRoot, "manifest.json"), "utf8"),
  );
  assert.deepEqual(productionManifest.snippets["reference-client-transports"], {
    source: "reference-client-transports.ts",
  });
  assert.deepEqual(productionManifest.snippets["reference-ui-provider"], {
    source: "reference-ui-provider.tsx",
  });
  const sourceCount = (await readdir(examplesRoot, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.tsx?$/.test(entry.name),
  ).length;
  const result = await checkExamples({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(result.locales, ["en", "ja"]);
  assert.equal(result.examples, Object.keys(productionManifest.snippets).length);
  assert.equal(result.sources, sourceCount);
});

test("whitespace-only marker adjacency passes and intervening content fails", async (t) => {
  await t.test("formatter blank line", async (t) => {
    const value = await fixture(t);
    assert.equal((await checkExamples(value.options)).examples, 1);
  });

  await t.test("intervening MDX node", async (t) => {
    const value = await fixture(t);
    await writeFile(
      join(value.en, "fixture.mdx"),
      mdx(value.id, "ts", value.source, "\nThis breaks adjacency.\n"),
    );
    await expectDiagnostic(value.options, /not adjacent to a TypeScript fence/);
  });
});

test("unmapped fences and HTML markers cannot bypass the JSX marker contract", async (t) => {
  await t.test("unmapped", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.en, "fixture.mdx"), `\`\`\`ts\n${value.source}\`\`\`\n`);
    await expectDiagnostic(value.options, /missing an adjacent zhs-example marker/);
  });

  await t.test("HTML marker", async (t) => {
    const value = await fixture(t);
    await writeFile(
      join(value.en, "fixture.mdx"),
      `<!-- zhs-example: ${value.id} -->\n\n\`\`\`ts\n${value.source}\`\`\`\n`,
    );
    await expectDiagnostic(value.options, /HTML example markers are not MDX-compatible/);
  });

  await t.test("nested TypeScript fence", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.en, "fixture.mdx"), `> \`\`\` ts\n> ${value.source}> \`\`\`\n`);
    await expectDiagnostic(value.options, /nested TypeScript fences are not supported/);
  });

  await t.test("spaced backtick TypeScript fence", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.en, "bypass.mdx"), '\`\`\` ts\nconsole.log("sentinel");\n\`\`\`\n');
    await expectDiagnostic(value.options, /missing an adjacent zhs-example marker/);
  });

  await t.test("spaced tilde TypeScript fence", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.en, "bypass.mdx"), '  ~~~ ts\nconsole.log("sentinel");\n  ~~~\n');
    await expectDiagnostic(value.options, /missing an adjacent zhs-example marker/);
  });
});

test("manifest/source mapping rejects missing, unsafe, stale, and wrong-extension entries", async (t) => {
  await t.test("missing source", async (t) => {
    const value = await fixture(t);
    await rm(join(value.examplesRoot, value.sourceName));
    await expectDiagnostic(value.options, /source reference-fixture\.ts is unavailable/);
  });

  await t.test("traversal", async (t) => {
    const value = await fixture(t);
    await writeFile(value.manifestPath, manifest({ [value.id]: "../reference-fixture.ts" }));
    await expectDiagnostic(value.options, /unsafe or mismatched source/);
  });

  await t.test("stale entry", async (t) => {
    const value = await fixture(t);
    await writeFile(
      value.manifestPath,
      manifest({ [value.id]: value.sourceName, "reference-stale": "reference-stale.ts" }),
    );
    await expectDiagnostic(value.options, /stale unreferenced example reference-stale/);
  });

  await t.test("language/extension", async (t) => {
    const value = await fixture(t);
    await rm(join(value.examplesRoot, value.sourceName));
    await writeFile(join(value.examplesRoot, `${value.id}.tsx`), value.source);
    await writeFile(value.manifestPath, manifest({ [value.id]: `${value.id}.tsx` }));
    await expectDiagnostic(
      value.options,
      /example reference-fixture must map to reference-fixture\.ts/,
    );
  });
});

test("duplicate IDs, locale byte drift, and unmapped sources fail closed", async (t) => {
  await t.test("duplicate id within one locale", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.en, "duplicate.mdx"), mdx(value.id, "ts", value.source));
    await expectDiagnostic(value.options, /en: duplicate example id reference-fixture/);
  });

  await t.test("same id with different extension", async (t) => {
    const value = await fixture(t, { withJapanese: true });
    await writeFile(join(value.ja, "fixture.mdx"), mdx(value.id, "tsx", value.source));
    await writeFile(join(value.examplesRoot, `${value.id}.tsx`), value.source);
    await expectDiagnostic(
      value.options,
      /maps to both reference-fixture\.ts and reference-fixture\.tsx/,
    );
  });

  await t.test("translated bytes drift", async (t) => {
    const value = await fixture(t, { withJapanese: true });
    await writeFile(
      join(value.ja, "fixture.mdx"),
      mdx(value.id, "ts", "export const fixtureValue = 43;\n"),
    );
    await expectDiagnostic(value.options, /displayed bytes do not match reference-fixture\.ts/);
  });

  await t.test("unmapped direct source", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.examplesRoot, "reference-orphan.ts"), "export {};\n");
    await expectDiagnostic(value.options, /unmapped source reference-orphan\.ts/);
  });

  await t.test("nested source", async (t) => {
    const value = await fixture(t);
    await mkdir(join(value.examplesRoot, "nested"));
    await writeFile(join(value.examplesRoot, "nested/reference-hidden.ts"), "export {};\n");
    await expectDiagnostic(
      value.options,
      /source must be a direct basename.*nested.*reference-hidden\.ts/,
    );
  });

  await t.test("case alias", async (t) => {
    const value = await fixture(t);
    await writeFile(join(value.examplesRoot, "Reference-Fixture.ts"), value.source);
    await expectDiagnostic(
      value.options,
      /case-ambiguous sources Reference-Fixture\.ts and reference-fixture\.ts|case-ambiguous sources reference-fixture\.ts and Reference-Fixture\.ts/,
    );
  });
});

test("tsconfig coverage and TypeScript diagnostics are part of the checker boundary", async (t) => {
  await t.test("source omitted", async (t) => {
    const value = await fixture(t);
    const config = JSON.parse(await readFile(value.tsconfigPath, "utf8"));
    config.include = ["./examples/reference-not-present.ts"];
    await writeFile(value.tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    await expectDiagnostic(value.options, /example source is not included: reference-fixture\.ts/);
  });

  await t.test("type error", async (t) => {
    const value = await fixture(t);
    const invalid = 'export const fixtureValue: number = "not a number";\n';
    await writeFile(join(value.examplesRoot, value.sourceName), invalid);
    await writeFile(join(value.en, "fixture.mdx"), mdx(value.id, "ts", invalid));
    await expectDiagnostic(
      value.options,
      /typecheck: .*Type 'string' is not assignable to type 'number'/,
    );
  });

  await t.test("lookalike public declaration path", async (t) => {
    const value = await fixture(t);
    const config = JSON.parse(await readFile(value.tsconfigPath, "utf8"));
    config.compilerOptions.paths["@takazudo/zudo-history-stash"] = [
      join(value.root, "shadow/packages/client/dist/index.d.ts"),
    ];
    await writeFile(value.tsconfigPath, `${JSON.stringify(config, null, 2)}\n`);
    await expectDiagnostic(
      value.options,
      /@takazudo\/zudo-history-stash must resolve only to packages\/client\/dist\/index\.d\.ts/,
    );
  });
});

test("raw and hand-written include forms cannot evade the inventory", async (t) => {
  for (const [name, payload, diagnostic] of [
    ["pre", "<pre>sentinel</pre>\n", /unsupported code\/include markup/],
    ["code", "<code>sentinel</code>\n", /unsupported code\/include markup/],
    [
      "nested raw markup",
      "<div><pre><code>const sentinel = true;</code></pre></div>\n",
      /unsupported code\/include markup/,
    ],
    [
      "embedded include",
      '<Aside><CodeInclude source="sentinel.ts" /></Aside>\n',
      /unsupported code\/include markup/,
    ],
    [
      "general indented code",
      '    console.log("sentinel");\n',
      /rendered indented code is not mapped/,
    ],
    ["tab-indented code", '\tconsole.log("sentinel");\n', /rendered indented code is not mapped/],
  ]) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await writeFile(join(value.en, "bypass.mdx"), payload);
      await expectDiagnostic(value.options, diagnostic);
    });
  }
});

test("symlink sources are rejected and generated Claude paths are excluded explicitly", async (t) => {
  const value = await fixture(t);
  const outside = join(value.root, "outside.ts");
  await writeFile(outside, value.source);
  await rm(join(value.examplesRoot, value.sourceName));
  await symlink(outside, join(value.examplesRoot, value.sourceName));
  await mkdir(join(value.en, "claude-generated"));
  await writeFile(join(value.en, "claude-generated", "unchecked.mdx"), "```ts\ninvalid !!!\n```\n");
  await expectDiagnostic(value.options, /regular non-symlink file/);
});

test("generated Claude directories are pruned before filesystem traversal", async (t) => {
  const value = await fixture(t);
  const generated = join(value.en, "claude-unreadable");
  await mkdir(generated);
  await chmod(generated, 0o000);
  try {
    assert.equal((await checkExamples(value.options)).examples, 1);
  } finally {
    await chmod(generated, 0o700);
  }
});

test("write mode emits one deterministic schema-version-1 manifest", async (t) => {
  const value = await fixture(t);
  await writeFile(value.manifestPath, "{}\n");
  const result = await checkExamples({ ...value.options, write: true });
  assert.equal(result.examples, 1);
  assert.equal(
    await readFile(value.manifestPath, "utf8"),
    manifest({ [value.id]: value.sourceName }),
  );
});
