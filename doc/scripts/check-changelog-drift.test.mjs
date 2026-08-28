import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  emitChangelogs,
  generateChangelogMarkdown,
  loadChangelogEntries,
  sanitizeChangelogMarkdown,
} from "@takazudo/zudo-doc/integrations/changelog";
import { parseFrontmatter } from "@takazudo/zfb/frontmatter";
import { CHANGELOGS } from "../changelog-config.mjs";
import {
  ChangelogDriftError,
  checkChangelogDrift,
  validateChangelogConfig,
} from "./check-changelog-drift.mjs";
import { checkLocaleParity, LocaleParityError } from "./check-locale-parity.mjs";

const DOC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(DOC_ROOT, "..");
const CHECKER_PATH = join(DOC_ROOT, "scripts/check-changelog-drift.mjs");
const REQUIRED_CHANGELOG_PAGES = [
  "client/0.1.0.mdx",
  "client/index.mdx",
  "core/0.1.0.mdx",
  "core/index.mdx",
  "index.mdx",
  "ui/0.1.0.mdx",
  "ui/index.mdx",
];
const FRONTMATTER_KEYS = ["title", "description", "sidebar_position", "category"];
const EXPECTED_CONFIG = [
  {
    slug: "core",
    sourceDir: "src/content/docs/changelog/core",
    outputFile: "../packages/core/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash-core",
  },
  {
    slug: "client",
    sourceDir: "src/content/docs/changelog/client",
    outputFile: "../packages/client/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash",
  },
  {
    slug: "ui",
    sourceDir: "src/content/docs/changelog/ui",
    outputFile: "../packages/ui/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash-ui",
  },
];
const ENGLISH_RELEASE_BODIES = {
  core: `- Define the complete v1 route table, principals, request/response types, strict Zod schemas, and
  stable error codes.
- Add shared stash/path validation, UTF-8 limits, canonical hashing, representation ETags, and
  conditional-request helpers.
- Add bounded stored and candidate text diffs with unified output, structured hunks, statistics,
  truncation, and explicit oversized states.`,
  client: `- Add the isomorphic \`createStashClient\` API for Node.js, browsers, and Cloudflare Worker service
  bindings.
- Cover administrator, token, import, file, history, change-feed, stored-diff, and candidate-diff
  routes with typed business outcomes.
- Add representation-cache handling, automatic idempotency keys, replay metadata, and bounded
  \`putLatest\` conflict retries.`,
  ui: `- Add the embeddable provider, capability hooks, link bridge, base primitives, and namespaced CSS
  surface.`,
};

function frontmatterKeys(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  assert.ok(match, "fixture must have closed leading frontmatter");
  return match[1]
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const key = /^([A-Za-z_][\w-]*)\s*:/u.exec(line);
      assert.ok(key, `unsupported frontmatter line: ${line}`);
      return key[1];
    });
}

async function changelogPages(root) {
  const pages = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      assert.equal(info.isSymbolicLink(), false, `changelog source must not be a symlink: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.mdx?$/u.test(entry.name)) {
        pages.push(relative(root, path).split("\\").join("/"));
      }
    }
  }
  await visit(root);
  return pages.sort((left, right) => left.localeCompare(right, "en"));
}

function releaseSource(slug) {
  return `---
title: 0.1.0
description: Fixture release for ${slug}.
sidebar_position: 1
category: changelog
---

Released: 2026-08-25

- FIXTURE_RELEASE_${slug.toUpperCase()}.
`;
}

async function createFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "zhs-changelog-test-"));
  const projectRoot = join(repositoryRoot, "doc");
  await mkdir(projectRoot, { recursive: true });
  for (const entry of CHANGELOGS) {
    const source = join(projectRoot, entry.sourceDir);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "index.mdx"), "# Fixture index\n");
    await writeFile(join(source, "_draft.mdx"), "# Ignored draft\n");
    await writeFile(join(source, "0.1.0.mdx"), releaseSource(entry.slug));
  }
  emitChangelogs({ projectRoot, changelogs: CHANGELOGS, logger: { info() {} } });
  return {
    repositoryRoot,
    projectRoot,
    cleanup: () => rm(repositoryRoot, { recursive: true, force: true }),
  };
}

function outputPath(projectRoot, entry) {
  return resolve(projectRoot, entry.outputFile);
}

async function snapshotOutputs(projectRoot) {
  return new Map(
    await Promise.all(
      CHANGELOGS.map(async (entry) => [entry.slug, await readFile(outputPath(projectRoot, entry))]),
    ),
  );
}

async function assertOutputsEqual(projectRoot, snapshots) {
  for (const entry of CHANGELOGS) {
    assert.deepEqual(await readFile(outputPath(projectRoot, entry)), snapshots.get(entry.slug));
  }
}

async function assertMissing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function assertDrift(options, pattern) {
  await assert.rejects(
    checkChangelogDrift(options),
    (error) => error instanceof ChangelogDriftError && pattern.test(error.message),
  );
}

function run(command, arguments_, options = {}) {
  const environment = { ...process.env, ...options.env };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(command, arguments_, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    env: environment,
  });
}

test("the shared config is one frozen, exact, resolvable core/client/ui authority", () => {
  assert.equal(Object.isFrozen(CHANGELOGS), true);
  assert.equal(CHANGELOGS.every(Object.isFrozen), true);
  assert.deepEqual(CHANGELOGS, EXPECTED_CONFIG);
  validateChangelogConfig(CHANGELOGS, { projectRoot: DOC_ROOT, repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(
    CHANGELOGS.map((entry) => relative(REPOSITORY_ROOT, outputPath(DOC_ROOT, entry))),
    ["packages/core/CHANGELOG.md", "packages/client/CHANGELOG.md", "packages/ui/CHANGELOG.md"],
  );
});

test("the real bilingual changelog inventory has the exact schema and per-field semantics", async () => {
  const localeRoots = [
    ["en", join(DOC_ROOT, "src/content/docs/changelog")],
    ["ja", join(DOC_ROOT, "src/content/docs-ja/changelog")],
  ];
  const inventories = await Promise.all(localeRoots.map(([, root]) => changelogPages(root)));
  assert.deepEqual(
    inventories[0],
    inventories[1],
    "locale inventories must stay dynamic and paired",
  );
  for (const required of REQUIRED_CHANGELOG_PAGES) {
    assert.ok(inventories[0].includes(required), `required initial page: ${required}`);
  }
  for (let localeIndex = 0; localeIndex < localeRoots.length; localeIndex += 1) {
    const [locale, root] = localeRoots[localeIndex];
    for (const relativePath of inventories[localeIndex]) {
      const source = await readFile(join(root, relativePath), "utf8");
      const data = parseFrontmatter(source).data;
      assert.deepEqual(frontmatterKeys(source), FRONTMATTER_KEYS, `${locale}:${relativePath}`);
      assert.equal(typeof data.title, "string", `${locale}:${relativePath} title`);
      assert.ok(data.title.trim(), `${locale}:${relativePath} title`);
      assert.equal(typeof data.description, "string", `${locale}:${relativePath} description`);
      assert.ok(data.description.trim(), `${locale}:${relativePath} description`);
      assert.match(data.sidebar_position, /^\d+$/u, `${locale}:${relativePath} sidebar_position`);
      assert.equal(data.category, "changelog", `${locale}:${relativePath} category`);
      const release = /^(core|client|ui)\/([0-9]+\.[0-9]+\.[0-9]+)\.mdx?$/u.exec(relativePath);
      if (release) {
        assert.equal(data.title, release[2], `${locale}:${relativePath} release title`);
        assert.equal(data.category, "changelog", `${locale}:${relativePath} release category`);
        const slug = relativePath.split("/")[0];
        const marker = locale === "en" ? "Released" : "リリース日";
        assert.match(source, new RegExp(`^${marker}: [0-9]{4}-[0-9]{2}-[0-9]{2}$`, "mu"));
        if (release[2] === "0.1.0") {
          const date = slug === "ui" ? "2026-08-26" : "2026-08-25";
          assert.match(source, new RegExp(`^${marker}: ${date}$`, "mu"));
          if (locale === "en") {
            assert.equal(
              source.split(`Released: ${date}\n\n`)[1].trim(),
              ENGLISH_RELEASE_BODIES[slug],
            );
          }
        }
      }
    }
  }
});

test("the public API keeps filtering, SemVer order, sanitizing, and exact generated framing", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhs-public-changelog-"));
  try {
    const sourceDir = join(root, "releases");
    const outputFile = join(root, "CHANGELOG.md");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "index.mdx"), "INDEX_SENTINEL\n");
    await writeFile(join(sourceDir, "_draft.mdx"), "DRAFT_SENTINEL\n");
    await writeFile(
      join(sourceDir, "0.2.0.mdx"),
      `---
title: 0.2.0
---

Released: 2026-01-02

import Hidden from "./hidden";

{/* COMMENT_SENTINEL */}

<Note>
PUBLIC_API_SENTINEL
</Note>
`,
    );
    await writeFile(
      join(sourceDir, "1.0.0.mdx"),
      "---\ntitle: 1.0.0\n---\n\nReleased: 2026-02-03\n\n- NEWEST_SENTINEL\n",
    );
    const entries = loadChangelogEntries({ sourceDir });
    assert.deepEqual(
      entries.map((entry) => entry.version),
      ["1.0.0", "0.2.0"],
    );
    assert.equal(entries[1].content, "> **Note**\nPUBLIC_API_SENTINEL");
    assert.equal(
      sanitizeChangelogMarkdown('import Hidden from "./hidden";\n\n<Warning>VISIBLE</Warning>'),
      "VISIBLE",
    );
    const generated = generateChangelogMarkdown(entries, { packageName: "@fixture/pkg" });
    assert.ok(
      generated.startsWith(
        "# Changelog\n\nAll notable changes to `@fixture/pkg` are documented in this file.\n\nThe format is based on Keep a Changelog, and release notes are generated from the changelog MDX pages.\n",
      ),
    );
    assert.ok(
      generated.indexOf("## [1.0.0] - 2026-02-03") < generated.indexOf("## [0.2.0] - 2026-01-02"),
    );
    assert.ok(generated.endsWith("\n"));
    assert.doesNotMatch(generated, /INDEX_SENTINEL|DRAFT_SENTINEL|COMMENT_SENTINEL|import Hidden/u);
    const result = emitChangelogs({
      projectRoot: root,
      changelogs: [
        { sourceDir: "releases", outputFile: "CHANGELOG.md", packageName: "@fixture/pkg" },
      ],
    });
    assert.deepEqual(result.written, [outputFile]);
    assert.equal(await readFile(outputFile, "utf8"), generated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the checker emits once, observes a sentinel, and removes its successful temp root", async () => {
  const fixture = await createFixture();
  const roots = [];
  let emitCalls = 0;
  try {
    const result = await checkChangelogDrift({
      projectRoot: fixture.projectRoot,
      repositoryRoot: fixture.repositoryRoot,
      tempParent: fixture.repositoryRoot,
      onTempRoot(path) {
        roots.push(path);
      },
      emit(options) {
        emitCalls += 1;
        return emitChangelogs(options);
      },
    });
    assert.equal(emitCalls, 1);
    assert.equal(result.checked.length, 3);
    assert.match(await readFile(result.checked[0], "utf8"), /FIXTURE_RELEASE_CORE/u);
    assert.equal(roots.length, 1);
    await assertMissing(roots[0]);
  } finally {
    await fixture.cleanup();
  }
});

test("each one-byte target edit fails read-only and removes its candidate root", async (t) => {
  const fixture = await createFixture();
  try {
    for (const entry of CHANGELOGS) {
      await t.test(entry.slug, async () => {
        const target = outputPath(fixture.projectRoot, entry);
        const original = await readFile(target);
        const altered = Buffer.from(original);
        altered[altered.length - 1] = altered[altered.length - 1] === 10 ? 32 : 10;
        await writeFile(target, altered);
        const roots = [];
        await assertDrift(
          {
            projectRoot: fixture.projectRoot,
            repositoryRoot: fixture.repositoryRoot,
            tempParent: fixture.repositoryRoot,
            onTempRoot(path) {
              roots.push(path);
            },
          },
          new RegExp(`differs for ${entry.slug}.*pnpm build:doc`, "su"),
        );
        assert.deepEqual(await readFile(target), altered);
        assert.equal(roots.length, 1);
        await assertMissing(roots[0]);
        await writeFile(target, original);
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a source edit and missing target fail without changing or recreating outputs", async () => {
  const fixture = await createFixture();
  try {
    const snapshots = await snapshotOutputs(fixture.projectRoot);
    const coreSource = join(fixture.projectRoot, CHANGELOGS[0].sourceDir, "0.1.0.mdx");
    await writeFile(coreSource, `${await readFile(coreSource, "utf8")}\n- SOURCE_EDIT_SENTINEL.\n`);
    const sourceRoots = [];
    await assertDrift(
      {
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
        tempParent: fixture.repositoryRoot,
        onTempRoot(path) {
          sourceRoots.push(path);
        },
      },
      /differs for core/u,
    );
    assert.equal(sourceRoots.length, 1);
    await assertMissing(sourceRoots[0]);
    await assertOutputsEqual(fixture.projectRoot, snapshots);
    await writeFile(coreSource, releaseSource("core"));

    const clientTarget = outputPath(fixture.projectRoot, CHANGELOGS[1]);
    await rm(clientTarget);
    const missingTargetRoots = [];
    await assertDrift(
      {
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
        tempParent: fixture.repositoryRoot,
        onTempRoot(path) {
          missingTargetRoots.push(path);
        },
      },
      /Committed changelog for client is missing/u,
    );
    assert.equal(missingTargetRoots.length, 1);
    await assertMissing(missingTargetRoots[0]);
    await assertMissing(clientTarget);
    assert.deepEqual(
      await readFile(outputPath(fixture.projectRoot, CHANGELOGS[0])),
      snapshots.get("core"),
    );
    assert.deepEqual(
      await readFile(outputPath(fixture.projectRoot, CHANGELOGS[2])),
      snapshots.get("ui"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("missing and existing-but-empty sources fail before emission or temp creation", async (t) => {
  for (const mode of ["missing", "empty"]) {
    await t.test(mode, async () => {
      const fixture = await createFixture();
      let emitCalls = 0;
      let tempCalls = 0;
      try {
        const source = join(fixture.projectRoot, CHANGELOGS[0].sourceDir);
        if (mode === "missing") await rm(source, { recursive: true });
        else {
          for (const name of await readdir(source)) {
            if (!/^index\.mdx$/u.test(name) && !name.startsWith("_")) await rm(join(source, name));
          }
        }
        await assertDrift(
          {
            projectRoot: fixture.projectRoot,
            repositoryRoot: fixture.repositoryRoot,
            emit() {
              emitCalls += 1;
              throw new Error("emit must not run");
            },
            onTempRoot() {
              tempCalls += 1;
            },
          },
          mode === "missing"
            ? /source is missing for core/u
            : /source has no release entries for core/u,
        );
        assert.equal(emitCalls, 0);
        assert.equal(tempCalls, 0);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("malformed release inputs fail deterministically before emission or temp creation", async (t) => {
  const valid = releaseSource("core");
  const cases = [
    ["unclosed frontmatter", "---\ntitle: 0.1.0\n", /malformed frontmatter/u],
    [
      "invalid frontmatter line",
      valid.replace("description:", "not yaml\ndescription:"),
      /malformed frontmatter/u,
    ],
    [
      "missing field",
      valid.replace("description: Fixture release for core.\n", ""),
      /must have exactly/u,
    ],
    [
      "empty description",
      valid.replace("description: Fixture release for core.", "description:"),
      /description must be nonempty/u,
    ],
    [
      "nonnumeric sidebar",
      valid.replace("sidebar_position: 1", "sidebar_position: first"),
      /sidebar_position must be numeric/u,
    ],
    [
      "wrong category",
      valid.replace("category: changelog", "category: guide"),
      /category must be changelog/u,
    ],
    [
      "missing date",
      valid.replace("Released: 2026-08-25", "No release date"),
      /standalone Released/u,
    ],
    ["malformed date", valid.replace("2026-08-25", "2026-8-25"), /standalone Released/u],
    [
      "duplicate date",
      valid.replace("Released: 2026-08-25", "Released: 2026-08-25\nReleased: 2026-08-26"),
      /standalone Released/u,
    ],
    [
      "title filename mismatch",
      valid.replace("title: 0.1.0", "title: 0.1.1"),
      /matching its filename/u,
    ],
  ];
  for (const [name, contents, diagnostic] of cases) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      let emitCalls = 0;
      let tempCalls = 0;
      try {
        await writeFile(join(fixture.projectRoot, CHANGELOGS[0].sourceDir, "0.1.0.mdx"), contents);
        await assertDrift(
          {
            projectRoot: fixture.projectRoot,
            repositoryRoot: fixture.repositoryRoot,
            emit() {
              emitCalls += 1;
              throw new Error("emit must not run");
            },
            onTempRoot() {
              tempCalls += 1;
            },
          },
          diagnostic,
        );
        assert.equal(emitCalls, 0);
        assert.equal(tempCalls, 0);
      } finally {
        await fixture.cleanup();
      }
    });
  }

  await t.test("prefix SemVer title and filename", async () => {
    const fixture = await createFixture();
    try {
      const source = join(fixture.projectRoot, CHANGELOGS[0].sourceDir);
      await rm(join(source, "0.1.0.mdx"));
      await writeFile(join(source, "0.1.0beta.mdx"), valid.replaceAll("0.1.0", "0.1.0beta"));
      await assertDrift(
        { projectRoot: fixture.projectRoot, repositoryRoot: fixture.repositoryRoot },
        /exact plain SemVer/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("duplicate version across md and mdx", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.projectRoot, CHANGELOGS[0].sourceDir, "0.1.0.md"), valid);
      await assertDrift(
        { projectRoot: fixture.projectRoot, repositoryRoot: fixture.repositoryRoot },
        /Duplicate changelog release version for core/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("case-variant Index.mdx is not silently excluded", async () => {
    const fixture = await createFixture();
    let emitCalls = 0;
    let tempCalls = 0;
    try {
      await writeFile(
        join(fixture.projectRoot, CHANGELOGS[0].sourceDir, "Index.mdx"),
        "# Not an index\n",
      );
      await assertDrift(
        {
          projectRoot: fixture.projectRoot,
          repositoryRoot: fixture.repositoryRoot,
          emit() {
            emitCalls += 1;
            throw new Error("emit must not run");
          },
          onTempRoot() {
            tempCalls += 1;
          },
        },
        /malformed frontmatter for core: Index\.mdx/u,
      );
      assert.equal(emitCalls, 0);
      assert.equal(tempCalls, 0);
    } finally {
      await fixture.cleanup();
    }
  });
});

test("source and committed-output symlinks fail closed before emission", async (t) => {
  await t.test("release file symlink", async () => {
    const fixture = await createFixture();
    try {
      const source = join(fixture.projectRoot, CHANGELOGS[0].sourceDir);
      await rm(join(source, "0.1.0.mdx"));
      await symlink(
        join(fixture.projectRoot, CHANGELOGS[1].sourceDir, "0.1.0.mdx"),
        join(source, "0.1.0.mdx"),
      );
      await assertDrift(
        { projectRoot: fixture.projectRoot, repositoryRoot: fixture.repositoryRoot },
        /release must be a real file/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
  await t.test("source directory symlink", async () => {
    const fixture = await createFixture();
    try {
      const source = join(fixture.projectRoot, CHANGELOGS[0].sourceDir);
      await rm(source, { recursive: true });
      await symlink(join(fixture.projectRoot, CHANGELOGS[1].sourceDir), source);
      await assertDrift(
        { projectRoot: fixture.projectRoot, repositoryRoot: fixture.repositoryRoot },
        /source must be a real directory/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
  await t.test("committed output symlink", async () => {
    const fixture = await createFixture();
    try {
      const output = outputPath(fixture.projectRoot, CHANGELOGS[0]);
      await rm(output);
      await symlink(outputPath(fixture.projectRoot, CHANGELOGS[1]), output);
      await assertDrift(
        { projectRoot: fixture.projectRoot, repositoryRoot: fixture.repositoryRoot },
        /Committed changelog must be a real file/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("invalid mappings fail at the public checker boundary before generation", async (t) => {
  const fixture = await createFixture();
  const cases = {
    "duplicate slug": (entries) => {
      entries[1].slug = entries[0].slug;
    },
    "duplicate source": (entries) => {
      entries[1].sourceDir = entries[0].sourceDir;
    },
    "duplicate output": (entries) => {
      entries[1].outputFile = entries[0].outputFile;
    },
    "duplicate package": (entries) => {
      entries[1].packageName = entries[0].packageName;
    },
    incomplete: (entries) => {
      delete entries[0].packageName;
    },
    "wrong package": (entries) => {
      entries[0].packageName = "@fixture/wrong";
    },
    extra: (entries) => {
      entries.push({ ...entries[0], slug: "extra" });
    },
    missing: (entries) => {
      entries.pop();
    },
    reordered: (entries) => {
      entries.reverse();
    },
    "Japanese source": (entries) => {
      entries[0].sourceDir = "src/content/docs-ja/changelog/core";
    },
    "source escape": (entries) => {
      entries[0].sourceDir = "../outside";
    },
    "output escape": (entries) => {
      entries[0].outputFile = "../../outside.md";
    },
  };
  try {
    for (const [name, mutate] of Object.entries(cases)) {
      await t.test(name, async () => {
        const entries = CHANGELOGS.map((entry) => ({ ...entry }));
        mutate(entries);
        let emitCalls = 0;
        let tempCalls = 0;
        await assert.rejects(
          checkChangelogDrift({
            projectRoot: fixture.projectRoot,
            repositoryRoot: fixture.repositoryRoot,
            changelogs: entries,
            emit() {
              emitCalls += 1;
              throw new Error("invalid config reached emit");
            },
            onTempRoot() {
              tempCalls += 1;
            },
          }),
          ChangelogDriftError,
        );
        assert.equal(emitCalls, 0);
        assert.equal(tempCalls, 0);
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("Japanese prose is not a generator input, while locale parity still detects its structural drift", async () => {
  const fixture = await createFixture();
  try {
    const japaneseDecoy = join(fixture.projectRoot, "src/content/docs-ja/changelog/core/0.1.0.mdx");
    await mkdir(dirname(japaneseDecoy), { recursive: true });
    await writeFile(
      japaneseDecoy,
      releaseSource("core").replace("FIXTURE_RELEASE_CORE", "JA_ONLY_SENTINEL"),
    );
    const before = await readFile(outputPath(fixture.projectRoot, CHANGELOGS[0]), "utf8");
    assert.doesNotMatch(before, /JA_ONLY_SENTINEL/u);
    await checkChangelogDrift({
      projectRoot: fixture.projectRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    await writeFile(
      japaneseDecoy,
      `${await readFile(japaneseDecoy, "utf8")}\nJA_PROSE_EDIT_SENTINEL\n`,
    );
    await checkChangelogDrift({
      projectRoot: fixture.projectRoot,
      repositoryRoot: fixture.repositoryRoot,
    });
    assert.equal(await readFile(outputPath(fixture.projectRoot, CHANGELOGS[0]), "utf8"), before);

    const enRoot = join(fixture.repositoryRoot, "locale-en");
    const jaRoot = join(fixture.repositoryRoot, "locale-ja");
    await mkdir(enRoot);
    await mkdir(jaRoot);
    const en =
      "---\ntitle: Page\ndescription: English.\nsidebar_position: 1\ncategory: changelog\n---\n\nEnglish prose.\n";
    const ja =
      "---\ntitle: ページ\ndescription: 日本語です。\nsidebar_position: 1\ncategory: changelog\n---\n\n日本語の本文です。\n";
    await writeFile(join(enRoot, "page.mdx"), en);
    await writeFile(join(jaRoot, "page.mdx"), ja);
    await checkLocaleParity({ enRoot, jaRoot });
    await writeFile(join(jaRoot, "page.mdx"), `${ja}\n\`JA_STRUCTURAL_SENTINEL\`\n`);
    await assert.rejects(checkLocaleParity({ enRoot, jaRoot }), LocaleParityError);
  } finally {
    await fixture.cleanup();
  }
});

test("multiple drift is ordered and a generator throw remains clean and read-only", async () => {
  const fixture = await createFixture();
  try {
    const snapshots = await snapshotOutputs(fixture.projectRoot);
    for (const entry of CHANGELOGS.slice(0, 2)) {
      await writeFile(
        outputPath(fixture.projectRoot, entry),
        Buffer.from(`ALTERED_${entry.slug}\n`),
      );
    }
    let error;
    try {
      await checkChangelogDrift({
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ChangelogDriftError);
    assert.ok(
      error.message.indexOf("differs for core") < error.message.indexOf("differs for client"),
    );
    for (const entry of CHANGELOGS.slice(0, 2)) {
      await writeFile(outputPath(fixture.projectRoot, entry), snapshots.get(entry.slug));
    }

    const roots = [];
    await assert.rejects(
      checkChangelogDrift({
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
        tempParent: fixture.repositoryRoot,
        onTempRoot(path) {
          roots.push(path);
        },
        emit() {
          throw new Error("GENERATOR_THROW_SENTINEL");
        },
      }),
      /GENERATOR_THROW_SENTINEL/u,
    );
    assert.equal(roots.length, 1);
    await assertMissing(roots[0]);
    await assertOutputsEqual(fixture.projectRoot, snapshots);

    roots.length = 0;
    await assert.rejects(
      checkChangelogDrift({
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
        tempParent: fixture.repositoryRoot,
        onTempRoot(path) {
          roots.push(path);
        },
        async emit() {
          throw new Error("ASYNC_GENERATOR_REJECTION_SENTINEL");
        },
      }),
      /ASYNC_GENERATOR_REJECTION_SENTINEL/u,
    );
    assert.equal(roots.length, 1);
    await assertMissing(roots[0]);
    await assertOutputsEqual(fixture.projectRoot, snapshots);

    roots.length = 0;
    await assertDrift(
      {
        projectRoot: fixture.projectRoot,
        repositoryRoot: fixture.repositoryRoot,
        tempParent: fixture.repositoryRoot,
        onTempRoot(path) {
          roots.push(path);
        },
        emit(options) {
          emitChangelogs(options);
          return { written: [] };
        },
      },
      /did not report the exact three candidate outputs/u,
    );
    assert.equal(roots.length, 1);
    await assertMissing(roots[0]);
    await assertOutputsEqual(fixture.projectRoot, snapshots);
  } finally {
    await fixture.cleanup();
  }
});

test("the production CLI is cwd-independent from repository, Docs, and unrelated roots", async () => {
  const unrelated = await mkdtemp(join(tmpdir(), "zhs-changelog-cwd-"));
  try {
    for (const [index, cwd] of [REPOSITORY_ROOT, DOC_ROOT, unrelated].entries()) {
      const output = join(unrelated, `cli-${index}.log`);
      const result = run(
        "bash",
        [
          "-c",
          '/usr/bin/env -i "$1" "$2" >"$3" 2>&1',
          "changelog-cli",
          process.execPath,
          CHECKER_PATH,
          output,
        ],
        { cwd },
      );
      const contents = await readFile(output, "utf8");
      assert.equal(result.status, 0, `${cwd}: ${contents}`);
      assert.match(contents, /passed \(3 generated artifacts\)/u);
    }
  } finally {
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("formatter ownership excludes generated outputs in recursive and Lefthook command shapes only", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "zhs-changelog-format-"));
  try {
    const projectRoot = join(fixture, "doc");
    const susceptibleRelease = `---
title: 0.1.0
description: Formatter fixture.
sidebar_position: 1
category: changelog
---

Released: 2026-08-25

# FORMATTER_RED_SENTINEL
- value
`;
    for (const entry of CHANGELOGS) {
      const source = join(projectRoot, entry.sourceDir);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "0.1.0.mdx"), susceptibleRelease);
    }
    emitChangelogs({ projectRoot, changelogs: CHANGELOGS, logger: { info() {} } });
    const generatedPaths = CHANGELOGS.map((entry) =>
      relative(fixture, outputPath(projectRoot, entry)),
    );
    const snapshots = await snapshotOutputs(projectRoot);
    const formatterConfig = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, ".mdx-formatter.json"), "utf8"),
    );
    await writeFile(
      join(fixture, ".mdx-formatter.json"),
      `${JSON.stringify(formatterConfig, null, 2)}\n`,
    );
    await writeFile(join(fixture, "package.json"), '{"name":"formatter-fixture","private":true}\n');
    await symlink(join(REPOSITORY_ROOT, "node_modules"), join(fixture, "node_modules"), "dir");

    const contributing = join(fixture, "CONTRIBUTING.md");
    const enSource = join(fixture, "doc/src/content/docs/changelog/human.mdx");
    const jaSource = join(fixture, "doc/src/content/docs-ja/changelog/human.mdx");
    const unformattedHuman = "# Human\n- HUMAN_MARKDOWN_SENTINEL\n";
    await writeFile(contributing, unformattedHuman);
    await mkdir(dirname(enSource), { recursive: true });
    await mkdir(dirname(jaSource), { recursive: true });
    await writeFile(enSource, unformattedHuman);
    await writeFile(jaSource, unformattedHuman);

    const formatter = join(REPOSITORY_ROOT, "node_modules/.bin/mdx-formatter");
    const recursive = run(
      formatter,
      ["--write", "--config", join(fixture, ".mdx-formatter.json"), "**/*.{md,mdx}"],
      { cwd: fixture },
    );
    assert.equal(recursive.status, 0, recursive.stderr);
    await assertOutputsEqual(projectRoot, snapshots);
    assert.notEqual(await readFile(contributing, "utf8"), unformattedHuman);
    assert.notEqual(await readFile(enSource, "utf8"), unformattedHuman);
    assert.notEqual(await readFile(jaSource, "utf8"), unformattedHuman);

    const lefthook = run("pnpm", ["exec", "mdx-formatter", "--write", ...generatedPaths], {
      cwd: fixture,
      env: { PATH: `${join(REPOSITORY_ROOT, "node_modules/.bin")}:${process.env.PATH}` },
    });
    assert.equal(lefthook.status, 0, `${lefthook.stdout}\n${lefthook.stderr}`);
    await assertOutputsEqual(projectRoot, snapshots);

    formatterConfig.exclude = formatterConfig.exclude.filter(
      (pattern) => pattern !== "packages/*/CHANGELOG.md",
    );
    await writeFile(
      join(fixture, ".mdx-formatter.json"),
      `${JSON.stringify(formatterConfig, null, 2)}\n`,
    );
    for (const entry of CHANGELOGS) {
      await writeFile(outputPath(projectRoot, entry), snapshots.get(entry.slug));
    }
    const red = run("pnpm", ["exec", "mdx-formatter", "--write", ...generatedPaths], {
      cwd: fixture,
      env: { PATH: `${join(REPOSITORY_ROOT, "node_modules/.bin")}:${process.env.PATH}` },
    });
    assert.equal(red.status, 0, `${red.stdout}\n${red.stderr}`);
    for (const entry of CHANGELOGS) {
      assert.notDeepEqual(
        await readFile(outputPath(projectRoot, entry)),
        snapshots.get(entry.slug),
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
