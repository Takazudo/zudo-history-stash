import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  __test,
  buildLocaleManifest,
  checkLocaleParity,
  checkLocaleRoutes,
  LocaleParityError,
} from "./check-locale-parity.mjs";
import { parseZfbConfig } from "./check-links.js";

const DOC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(DOC_ROOT, "..");
const CLI_PATH = join(DOC_ROOT, "scripts/check-locale-parity.mjs");

const EN_MDX = `---
title: Fixture
description: English fixture.
sidebar_position: 1
category: guide
---

import { Widget } from "./widget.js";
export { Widget };

## Contract heading

English prose with \`stable-token\` and [English label](./target.mdx#section). D1 precedes R2.

![English alt](./asset.png)

- First item
  - Nested item

| Name | Value |
| --- | --- |
| State | \`status=open\` or \`status=all\` |
| Escaped pipe | \`status=open\\|all\` |

{/* zhs-example: PARITY_SENTINEL */}

<Note tone="stable">English component prose.</Note>

:::warning
English warning.
:::

### \`GET /v1/example/{id}\`

**Contract:** operation \`getExample\`; principal \`read\`; transport \`any\`.

\`\`\`\`ts title=stable
const marker = "PARITY_FENCE_LONG";
\`\`\`
\`\`\`\`

~~~~txt title=stable
PARITY_FENCE_TILDE
~~~~
`;

const JA_MDX = `---
title: フィクスチャ
description: 日本語のフィクスチャです。
sidebar_position: 1
category: guide
---

import { Widget } from "./widget.js";
export { Widget };

## 契約の見出し

日本語の本文です。非 BMP の絵文字 🧭 の後に、\`stable-token\` と
[日本語のラベル](./target.mdx#section)を含みます。D1 は R2 より先です。

![日本語の代替テキスト](./asset.png)

- 最初の項目
  - 入れ子の項目

| 名前 | 値 |
| --- | --- |
| 状態 | \`status=open\` または \`status=all\` |
| エスケープ済みパイプ | \`status=open\\|all\` |

{/* zhs-example: PARITY_SENTINEL */}

<Note tone="stable">日本語のコンポーネント本文です。</Note>

:::warning
日本語の警告です。
:::

### \`GET /v1/example/{id}\`

**Contract:** operation \`getExample\`; principal \`read\`; transport \`any\`.

\`\`\`\`ts title=stable
const marker = "PARITY_FENCE_LONG";
\`\`\`
\`\`\`\`

~~~~txt title=stable
PARITY_FENCE_TILDE
~~~~
`;

const EN_MD = `---
title: Plain Markdown
description: English plain page.
sidebar_position: 2
category: guide
---

## Plain page

English prose.
`;

const JA_MD = `---
title: 通常の Markdown
description: 日本語の通常ページです。
sidebar_position: 2
category: guide
---

## 通常ページ

日本語の本文です。
`;

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhs-locale-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const enRoot = join(root, "en");
  const jaRoot = join(root, "ja");
  await Promise.all([
    write(join(enRoot, "guide/example.mdx"), EN_MDX),
    write(join(jaRoot, "guide/example.mdx"), JA_MDX),
    write(join(enRoot, "guide/plain.md"), EN_MD),
    write(join(jaRoot, "guide/plain.md"), JA_MD),
  ]);
  return {
    root,
    enRoot,
    jaRoot,
    options: { enRoot, jaRoot },
    en(path = "guide/example.mdx") {
      return join(enRoot, path);
    },
    ja(path = "guide/example.mdx") {
      return join(jaRoot, path);
    },
  };
}

async function mutate(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  assert.notEqual(after, before, `mutation did not change ${path}`);
  await writeFile(path, after);
}

async function snapshot(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path, { bigint: true });
      const name = relative(root, path).split("\\").join("/");
      if (entry.isDirectory()) {
        result.push([name, "directory", info.mode, info.mtimeNs]);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        result.push([name, "symlink", info.mode, info.mtimeNs]);
      } else {
        result.push([name, "file", info.mode, info.mtimeNs, await readFile(path)]);
      }
    }
  }
  await visit(root);
  return result;
}

async function expectFailure(value, pattern, check = checkLocaleParity) {
  const before = await snapshot(value.root);
  await assert.rejects(
    check(value.options),
    (error) =>
      error instanceof LocaleParityError &&
      error.diagnostics.some((diagnostic) => pattern.test(diagnostic)),
  );
  assert.deepEqual(await snapshot(value.root), before, "the checker must not mutate its inputs");
}

async function runCli(cwd, outputPath, args = []) {
  const output = await open(outputPath, "w");
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], {
        cwd,
        stdio: ["ignore", output.fd, output.fd],
      });
      child.once("error", rejectRun);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolveRun();
          return;
        }
        rejectRun(new Error(`locale CLI exited with ${code ?? signal}`));
      });
    });
  } finally {
    await output.close();
  }
  return readFile(outputPath, "utf8");
}

test("matching md/mdx trees pass in sorted order and remain byte-for-byte read-only", async (t) => {
  const value = await fixture(t);
  const before = await snapshot(value.root);
  const summary = await checkLocaleParity(value.options);
  assert.deepEqual(
    summary.manifest.pairs.map((pair) => pair.relativePath),
    ["guide/example.mdx", "guide/plain.md"],
  );
  assert.equal(summary.pairs, 2);
  assert.deepEqual(await snapshot(value.root), before);
});

test("bidirectional discovery rejects missing, extra, case, extension, empty, and missing roots", async (t) => {
  const cases = [
    [
      "removed JA twin",
      async (value) => rm(value.ja("guide/example.mdx")),
      /inventory\/missing-ja.*missing Japanese source twin/,
    ],
    [
      "extra JA or removed EN twin",
      async (value) => rm(value.en("guide/example.mdx")),
      /inventory\/extra-ja.*no English twin/,
    ],
    [
      "case mismatch",
      async (value) => {
        await write(value.ja("guide/Example.mdx"), await readFile(value.ja(), "utf8"));
        await rm(value.ja());
      },
      /inventory\/(?:missing-ja|extra-ja)/,
    ],
    [
      "extension mismatch",
      async (value) => {
        await write(value.ja("guide/example.md"), await readFile(value.ja(), "utf8"));
        await rm(value.ja());
      },
      /inventory\/(?:missing-ja|extra-ja)/,
    ],
    [
      "empty EN root",
      async (value) => {
        const entries = await readdir(value.enRoot);
        assert.ok(entries.length > 0, "empty-root mutation requires existing source content");
        for (const entry of entries) {
          await rm(join(value.enRoot, entry), { recursive: true });
        }
        assert.equal((await lstat(value.enRoot)).isDirectory(), true);
        assert.deepEqual(await readdir(value.enRoot), []);
      },
      /^en: discovery\/empty: discovered zero hand-authored pages$/,
    ],
    [
      "missing JA root",
      async (value) => rm(value.jaRoot, { recursive: true }),
      /ja: discovery\/root/,
    ],
  ];
  for (const [name, change, diagnostic] of cases) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await change(value);
      await expectFailure(value, diagnostic);
    });
  }
});

test("source discovery rejects two filenames that normalize to one route", async (t) => {
  const value = await fixture(t);
  await Promise.all([
    write(value.en("collision.mdx"), EN_MD),
    write(value.en("collision/index.mdx"), EN_MD),
    write(value.ja("collision.mdx"), JA_MD),
    write(value.ja("collision/index.mdx"), JA_MD),
  ]);
  await expectFailure(value, /discovery\/duplicate-route/);
});

test("only the four generated EN prefixes and exact shared overview receive generated classification", async (t) => {
  const value = await fixture(t);
  const generated = (title = "Generated") =>
    `---\ntitle: ${title}\ndescription: Generated.\ngenerated: true\n---\n\nGenerated.\n`;
  for (const directory of ["claude-md", "claude-skills", "claude-agents", "claude-commands"]) {
    await write(value.en(`${directory}/tool.mdx`), generated());
  }
  const manifest = await buildLocaleManifest(value.options);
  assert.equal(manifest.defaultOnly.length, 4);

  await t.test("JA under an excluded prefix fails", async () => {
    await write(value.ja("claude-md/tool.mdx"), generated());
    await expectFailure(value, /localized source under an EN-only prefix is forbidden/);
    await rm(value.ja("claude-md/tool.mdx"));
  });

  await t.test("unrelated claude file remains paired", async () => {
    await write(value.en("claude-unrelated.mdx"), generated());
    await expectFailure(value, /claude-unrelated\.mdx.*missing Japanese source twin/);
    await rm(value.en("claude-unrelated.mdx"));
  });

  await t.test(
    "misplaced generated directory cannot hide behind broad ignore semantics",
    async () => {
      await write(value.en("claude-unrelated/page.mdx"), generated());
      await expectFailure(value, /claude-unrelated\/page\.mdx.*missing Japanese source twin/);
      await rm(value.en("claude-unrelated"), { recursive: true });
    },
  );

  await t.test("exact shared overview requires strict marker and shape", async () => {
    const shared = `---\ntitle: "Claude"\ndescription: "Claude Code configuration reference."\nsidebar_position: 899\ngenerated: true\n---\n\n## Resources\n\n<CategoryNav categories={["claude-md","claude-skills"]} />\n`;
    await write(value.en("claude/index.mdx"), shared);
    assert.equal((await buildLocaleManifest(value.options)).sharedGenerated.length, 1);
    await mutate(value.en("claude/index.mdx"), (source) =>
      source.replace("generated: true", "generated: false"),
    );
    await expectFailure(value, /generated-source\/marker/);

    await write(value.en("claude/index.mdx"), shared);
    await mutate(value.en("claude/index.mdx"), (source) =>
      source.replace("## Resources", "## Hand-authored resources"),
    );
    await expectFailure(value, /generated-source\/shape/);
  });
});

test("symlinked files, symlinked directories, and symlink roots fail without traversal", async (t) => {
  await t.test("file", async (t) => {
    const value = await fixture(t);
    await symlink(value.en(), value.en("guide/link.mdx"));
    await expectFailure(value, /discovery\/symlink/);
  });
  await t.test("directory", async (t) => {
    const value = await fixture(t);
    await symlink(join(value.enRoot, "guide"), join(value.enRoot, "linked-guide"));
    await expectFailure(value, /discovery\/symlink/);
  });
  await t.test("root", async (t) => {
    const value = await fixture(t);
    const linked = join(value.root, "linked-root");
    await symlink(value.enRoot, linked);
    value.options.enRoot = linked;
    await expectFailure(value, /source root must be a real directory/);
  });
});

test("frontmatter accepts translated prose and rejects key/value/delimiter drift", async (t) => {
  const cases = [
    ["missing key", (s) => s.replace("category: guide\n", ""), /frontmatter\/key-order/],
    [
      "extra key",
      (s) => s.replace("category: guide\n", "category: guide\nextra: stable\n"),
      /frontmatter\/key-order/,
    ],
    [
      "reordered key",
      (s) =>
        s.replace("sidebar_position: 1\ncategory: guide", "category: guide\nsidebar_position: 1"),
      /frontmatter\/key-order/,
    ],
    [
      "duplicate key",
      (s) => s.replace("category: guide", "category: guide\ncategory: guide"),
      /duplicate key/,
    ],
    [
      "position drift",
      (s) => s.replace("sidebar_position: 1", "sidebar_position: 9"),
      /value:sidebar_position/,
    ],
    ["category drift", (s) => s.replace("category: guide", "category: other"), /value:category/],
    ["empty title", (s) => s.replace("title: フィクスチャ", "title:"), /frontmatter\/title/],
    ["missing opener", (s) => s.replace(/^---\n/, ""), /frontmatter\/missing/],
    ["unclosed", (s) => s.replace("\n---\n\n", "\n\n"), /frontmatter\/unclosed/],
  ];
  for (const [name, transform, diagnostic] of cases) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.ja(), transform);
      await expectFailure(value, diagnostic);
    });
  }
});

test("raw fences reject byte, delimiter, metadata, order, count, line-ending, and closure drift", async (t) => {
  const cases = [
    ["one byte", (s) => s.replace("PARITY_FENCE_LONG", "PARITY_FENCE_lONG"), /fence\/raw-bytes/],
    ["language", (s) => s.replace("ts title=stable", "js title=stable"), /fence\/raw-bytes/],
    ["metadata", (s) => s.replace("title=stable", "title=changed"), /fence\/raw-bytes/],
    ["delimiter", (s) => s.replaceAll("~~~~", "~~~"), /fence\/raw-bytes/],
    [
      "order",
      (s) => {
        const blocks = s.match(/````ts[\s\S]*?````\n\n|~~~~txt[\s\S]*?~~~~\n/g);
        assert.equal(blocks.length, 2);
        return s
          .replace(blocks[0], "__FIRST__")
          .replace(blocks[1], blocks[0])
          .replace("__FIRST__", blocks[1]);
      },
      /fence\/raw-bytes/,
    ],
    ["removed", (s) => s.replace(/\n~~~~txt[\s\S]*?~~~~\n/, "\n"), /fence\/raw-bytes/],
    ["added", (s) => `${s}\n~~~txt\nADDED_FENCE\n~~~\n`, /fence\/raw-bytes/],
    ["unclosed", (s) => s.replace(/~~~~\n$/, ""), /fence\/unclosed/],
    [
      "line ending",
      (s) =>
        s.replace(
          'const marker = "PARITY_FENCE_LONG";\n',
          'const marker = "PARITY_FENCE_LONG";\r\n',
        ),
      /fence\/raw-bytes/,
    ],
  ];
  for (const [name, transform, diagnostic] of cases) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.ja(), transform);
      await expectFailure(value, diagnostic);
    });
  }
});

test("technical structure rejects independent executable and Markdown mutations", async (t) => {
  const cases = [
    ["inline code", (s) => s.replace("`stable-token`", "`changed-token`"), /structure\/order/],
    ["technical literal order", (s) => s.replace("D1 は R2", "R2 は D1"), /literal\/technical/],
    ["import", (s) => s.replace("./widget.js", "./other.js"), /structure\/order/],
    ["export", (s) => s.replace("export { Widget }", "export { Other }"), /structure\/order/],
    ["include ID", (s) => s.replace("PARITY_SENTINEL", "OTHER_SENTINEL"), /structure\/order/],
    ["route heading", (s) => s.replace("GET /v1/example", "POST /v1/example"), /structure\/order/],
    [
      "Contract principal",
      (s) => s.replace("principal `read`", "principal `write`"),
      /structure\/order/,
    ],
    ["component prop", (s) => s.replace('tone="stable"', 'tone="changed"'), /structure\/order/],
    [
      "link href",
      (s) => s.replace("./target.mdx#section", "./target.mdx#other"),
      /structure\/order/,
    ],
    ["image source", (s) => s.replace("./asset.png", "./other.png"), /structure\/order/],
    ["heading depth", (s) => s.replace("## 契約の見出し", "### 契約の見出し"), /structure\/order/],
    [
      "list nesting",
      (s) => s.replace("  - 入れ子の項目", "    - 入れ子の項目"),
      /structure\/order/,
    ],
    [
      "table shape",
      (s) =>
        s.replace(
          "| 状態 | `status=open` または `status=all` |",
          "| 状態 | 追加 | `status=open` または `status=all` |",
        ),
      /table\/cell-count/,
    ],
    ["admonition type", (s) => s.replace(":::warning", ":::tip"), /structure\/order/],
    ["unsupported expression", (s) => `${s}\n{dynamicValue}\n`, /unsupported syntax/],
  ];
  for (const [name, transform, diagnostic] of cases) {
    await t.test(name, async (t) => {
      const value = await fixture(t);
      await mutate(value.ja(), transform);
      await expectFailure(value, diagnostic);
    });
  }
});

test("matching malformed unescaped inline pipes fail independently in both locales", async (t) => {
  const value = await fixture(t);
  await Promise.all([
    mutate(value.en(), (source) =>
      source.replace("`status=open` or `status=all`", "`status=open|all`"),
    ),
    mutate(value.ja(), (source) =>
      source.replace("`status=open` または `status=all`", "`status=open|all`"),
    ),
  ]);
  const before = await snapshot(value.root);
  await assert.rejects(checkLocaleParity(value.options), (error) => {
    assert.ok(error instanceof LocaleParityError);
    assert.ok(
      error.diagnostics.some((diagnostic) =>
        /^en:guide\/example\.mdx: table\/cell-count .* body row has 3 cells; header has 2$/.test(
          diagnostic,
        ),
      ),
      "the English table must fail its own cell-count validation",
    );
    assert.ok(
      error.diagnostics.some((diagnostic) =>
        /^ja:guide\/example\.mdx: table\/cell-count .* body row has 3 cells; header has 2$/.test(
          diagnostic,
        ),
      ),
      "the Japanese table must fail its own cell-count validation",
    );
    return true;
  });
  assert.deepEqual(
    await snapshot(value.root),
    before,
    "the checker must remain read-only on failure",
  );
});

test("table-like rows inside multiline MDX comments are ignored and remain read-only", async (t) => {
  const value = await fixture(t);
  const marker = "{/* zhs-example: PARITY_SENTINEL */}";
  const hiddenTable = `{/* zhs-example: PARITY_SENTINEL
PARITY_COMMENT_TABLE_SENTINEL
| Hidden name | Hidden value |
| --- | --- |
| Hidden malformed row | extra | cell |
*/}`;
  await Promise.all([
    mutate(value.en(), (source) => source.replace(marker, hiddenTable)),
    mutate(value.ja(), (source) => source.replace(marker, hiddenTable)),
  ]);
  for (const path of [value.en(), value.ja()]) {
    assert.match(await readFile(path, "utf8"), /PARITY_COMMENT_TABLE_SENTINEL/);
  }

  const before = await snapshot(value.root);
  assert.equal((await checkLocaleParity(value.options)).pairs, 2);
  assert.deepEqual(await snapshot(value.root), before, "the checker must remain read-only");
});

async function writeBuiltRoute(root, route) {
  const clean = route.replace(/^\/+|\/+$/g, "");
  await write(join(root, clean, "index.html"), "<!doctype html><title>fixture</title>\n");
}

async function routeFixture(t, { base = "", trailingSlash = false } = {}) {
  const value = await fixture(t);
  const builtDir = join(value.root, "dist");
  const prefix = base.replace(/^\/+|\/+$/g, "");
  for (const route of [
    "docs/guide/example",
    "ja/docs/guide/example",
    "docs/guide/plain",
    "ja/docs/guide/plain",
    "docs/guide",
    "ja/docs/guide",
  ]) {
    await writeBuiltRoute(builtDir, [prefix, route].filter(Boolean).join("/"));
  }
  value.builtDir = builtDir;
  value.options = { ...value.options, builtDir, base: base || "/", trailingSlash };
  return value;
}

test("built routes prove both public switch directions from one supplied artifact", async (t) => {
  const value = await routeFixture(t);
  const before = await snapshot(value.root);
  assert.deepEqual(await checkLocaleRoutes(value.options), {
    pairs: 2,
    defaultRoutes: 3,
    localizedRoutes: 3,
    defaultOnlyRoutes: 0,
    sharedGeneratedRoutes: 0,
    autoIndexRoutes: 1,
  });
  assert.deepEqual(await snapshot(value.root), before);
});

test("built routes support base/trailing style and reject missing, unilateral, duplicate, and wrong-base output", async (t) => {
  await t.test("base and trailing slash", async (t) => {
    const value = await routeFixture(t, { base: "/base", trailingSlash: true });
    assert.equal((await checkLocaleRoutes(value.options)).pairs, 2);
  });
  await t.test("missing mapped target", async (t) => {
    const value = await routeFixture(t);
    await rm(join(value.builtDir, "ja/docs/guide/example"), { recursive: true });
    await expectFailure(value, /expected\/ja|switch\/en-to-ja/, checkLocaleRoutes);
  });
  await t.test("extra localized route", async (t) => {
    const value = await routeFixture(t);
    await writeBuiltRoute(value.builtDir, "ja/docs/unilateral");
    await expectFailure(value, /unexpected\/ja/, checkLocaleRoutes);
  });
  await t.test("extra paired routes", async (t) => {
    const value = await routeFixture(t);
    await writeBuiltRoute(value.builtDir, "docs/untracked");
    await writeBuiltRoute(value.builtDir, "ja/docs/untracked");
    await expectFailure(value, /unexpected\/(?:en|ja)/, checkLocaleRoutes);
  });
  await t.test("JA route under default-only prefix", async (t) => {
    const value = await routeFixture(t);
    await writeBuiltRoute(value.builtDir, "ja/docs/claude-md/rogue");
    await expectFailure(value, /default-only\/localized/, checkLocaleRoutes);
  });
  await t.test("duplicate normalized route", async (t) => {
    const value = await routeFixture(t);
    await write(join(value.builtDir, "docs/guide/example.html"), "<!doctype html>\n");
    await expectFailure(value, /built\/duplicate/, checkLocaleRoutes);
  });
  await t.test("wrong base", async (t) => {
    const value = await routeFixture(t, { base: "/base" });
    await cp(join(value.builtDir, "base/docs"), join(value.builtDir, "wrong/docs"), {
      recursive: true,
    });
    await expectFailure(value, /built\/base/, checkLocaleRoutes);
  });
});

test("source proof fails even when a synthetic JA fallback route remains", async (t) => {
  const value = await routeFixture(t);
  assert.ok(await stat(join(value.builtDir, "ja/docs/guide/example/index.html")));
  await rm(value.ja());
  await expectFailure(value, /inventory\/missing-ja/, checkLocaleRoutes);
});

test("the production CLI resolves roots independently of cwd", async (t) => {
  const unrelated = await mkdtemp(join(tmpdir(), "zhs-locale-cwd-"));
  t.after(() => rm(unrelated, { recursive: true, force: true }));
  const expectedPairs = (await checkLocaleParity()).pairs;
  assert.ok(expectedPairs > 0);

  for (const [index, cwd] of [REPOSITORY_ROOT, DOC_ROOT, unrelated].entries()) {
    const stdout = await runCli(cwd, join(unrelated, `cli-${index}.log`));
    const reported = /^Locale source parity OK \((\d+) EN\/JA pairs;/m.exec(stdout);
    assert.ok(reported, `missing positive source-pair summary from cwd ${cwd}`);
    assert.equal(Number(reported[1]), expectedPairs);
  }
});

test("the production routes CLI resolves one artifact independently of cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-locale-routes-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builtDir = join(root, "artifact");
  const manifest = await buildLocaleManifest();
  const contract = __test.routeContract(manifest);
  const config = await parseZfbConfig(join(DOC_ROOT, "zfb.config.ts"));
  const base = config.basePath === "/" ? "" : config.basePath.replace(/\/+$/, "");
  assert.ok(manifest.pairs.length > 0);

  for (const route of new Set([...contract.expectedDefault, ...contract.expectedLocalized])) {
    await writeBuiltRoute(builtDir, `${base}${route}`);
  }

  const builtArgument = relative(DOC_ROOT, builtDir).split("\\").join("/");
  for (const [index, cwd] of [REPOSITORY_ROOT, DOC_ROOT, root].entries()) {
    const stdout = await runCli(cwd, join(root, `routes-cli-${index}.log`), [
      "--routes-only",
      "--built-dir",
      builtArgument,
    ]);
    const reported = /^Locale routes OK \((\d+) source pairs; (\d+) EN \/ (\d+) JA routes;/m.exec(
      stdout,
    );
    assert.ok(reported, `missing positive route summary from cwd ${cwd}`);
    assert.equal(Number(reported[1]), manifest.pairs.length);
    assert.equal(Number(reported[2]), contract.expectedDefault.size);
    assert.equal(Number(reported[3]), contract.expectedLocalized.size);
  }
});
