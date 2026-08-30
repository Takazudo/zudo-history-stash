import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import prettier from "prettier";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function subprocessEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

test("root recursion, aliases, formatter ownership, CI parity, and skill naming are exact", async () => {
  const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const docManifest = JSON.parse(await readFile(join(repositoryRoot, "doc/package.json"), "utf8"));
  assert.equal(
    rootManifest.scripts.build,
    'pnpm -r --filter "!zudo-history-stash-doc" --if-present build',
  );
  assert.equal(
    rootManifest.scripts.test,
    'node --test scripts/*.test.mjs && pnpm -r --filter "!zudo-history-stash-doc" --if-present test',
  );
  assert.equal(
    rootManifest.scripts.typecheck,
    'pnpm -r --filter "!zudo-history-stash-doc" --if-present typecheck',
  );
  assert.equal(
    rootManifest.scripts.lint,
    'pnpm -r --filter "!zudo-history-stash-doc" --if-present lint',
  );
  assert.equal(rootManifest.scripts["dev:doc"], "pnpm --filter zudo-history-stash-doc dev");
  assert.equal(rootManifest.scripts["build:doc"], "pnpm --filter zudo-history-stash-doc build");
  assert.equal(rootManifest.scripts["check:doc"], "pnpm --filter zudo-history-stash-doc check");
  assert.equal(rootManifest.scripts["b4push:doc"], "pnpm --filter zudo-history-stash-doc b4push");
  assert.equal(
    rootManifest.scripts["format:md"],
    'pnpm exec mdx-formatter --write --config .mdx-formatter.json "**/*.{md,mdx}"',
  );
  assert.equal(
    rootManifest.scripts["format:md:check"],
    'pnpm exec mdx-formatter --check --config .mdx-formatter.json "**/*.{md,mdx}"',
  );

  for (const [name, command] of Object.entries({
    "setup:doc-skill": "bash scripts/setup-doc-skill.sh zudo-history-stash-wisdom",
    "setup:doc-skill-silent": "bash scripts/setup-doc-skill.sh --silent zudo-history-stash-wisdom",
    "setup:doc-skill:claude":
      "bash scripts/setup-doc-skill.sh --target claude zudo-history-stash-wisdom",
    "setup:doc-skill:codex":
      "bash scripts/setup-doc-skill.sh --target codex zudo-history-stash-wisdom",
    "setup:doc-skill:both":
      "bash scripts/setup-doc-skill.sh --target both zudo-history-stash-wisdom",
  })) {
    assert.equal(docManifest.scripts[name], command);
  }
  assert.equal(
    docManifest.scripts["check:template-drift"],
    "node scripts/check-template-drift.mjs",
  );

  const prettierIgnore = await readFile(join(repositoryRoot, ".prettierignore"), "utf8");
  assert.match(prettierIgnore, /^\*\*\/\*\.md$/m);
  assert.match(prettierIgnore, /^\*\*\/\*\.mdx$/m);
  const readmeInfo = await prettier.getFileInfo(join(repositoryRoot, "README.md"), {
    ignorePath: join(repositoryRoot, ".prettierignore"),
  });
  assert.equal(readmeInfo.ignored, true);
  const generatedOpenApiInfo = await prettier.getFileInfo(
    join(repositoryRoot, "doc/public/openapi.json"),
    { ignorePath: join(repositoryRoot, ".prettierignore") },
  );
  assert.equal(generatedOpenApiInfo.ignored, true);

  const formatter = JSON.parse(await readFile(join(repositoryRoot, ".mdx-formatter.json"), "utf8"));
  for (const exclusion of [
    "**/dist/**",
    "doc/src/content/docs/claude*/**",
    "doc/dist/**",
    "doc/.zfb*/**",
    "doc/.zudo-doc/**",
    "doc/.wrangler/**",
    "doc/.claude/skills/zudo-history-stash-wisdom/**",
    "doc/.codex/skills/zudo-history-stash-wisdom/**",
    "packages/*/CHANGELOG.md",
  ]) {
    assert.ok(formatter.exclude.includes(exclusion), `missing formatter exclusion ${exclusion}`);
  }
  const formatterIgnore = (await readFile(join(repositoryRoot, ".mdx-formatter-ignore"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  assert.deepEqual(formatterIgnore, formatter.exclude);
  const lefthook = await readFile(join(repositoryRoot, "lefthook.yml"), "utf8");
  assert.ok(
    lefthook.includes(
      "pnpm exec mdx-formatter --write --ignore-path .mdx-formatter-ignore {staged_files}",
    ),
  );
  assert.match(lefthook, /stage_fixed:\s*true/);
  assert.doesNotMatch(lefthook, /git add/);

  const parity = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/check-b4push-ci-parity.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: subprocessEnvironment(),
    },
  );
  assert.equal(parity.status, 0, parity.stderr + parity.stdout);
  assert.equal(
    await readFile(join(repositoryRoot, "doc/.htmlvalidate.json"), "utf8"),
    '{\n  "rules": {\n    "element-permitted-content": "error"\n  }\n}\n',
  );
});

test("recursive Markdown formatting skips nested build outputs", async () => {
  const formatter = JSON.parse(await readFile(join(repositoryRoot, ".mdx-formatter.json"), "utf8"));
  assert.equal(matchesGlob("workers/stash/dist/README.md", "dist/**"), false);
  assert.ok(
    formatter.exclude.some((pattern) => matchesGlob("workers/stash/dist/README.md", pattern)),
  );
});

test("CI parity fails if the Markdown check is removed, moved, or duplicated", async (t) => {
  const sourceRunner = await readFile(join(repositoryRoot, "scripts/run-b4push.sh"), "utf8");
  const sourceCi = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const sourceChecker = await readFile(
    join(repositoryRoot, "scripts/check-b4push-ci-parity.mjs"),
    "utf8",
  );
  for (const [name, mutate] of [
    [
      "removed",
      (source) =>
        source.replace(
          "      - name: Markdown format check\n        run: pnpm format:md:check\n\n",
          "",
        ),
    ],
    [
      "moved",
      (source) =>
        source.replace(
          "      - name: Markdown format check\n        run: pnpm format:md:check\n\n",
          "",
        ) + "\n      - name: Too late\n        run: pnpm format:md:check\n",
    ],
    [
      "duplicated",
      (source) =>
        source.replace(
          "        run: pnpm format:md:check",
          "        run: pnpm format:md:check\n\n      - name: Duplicate Markdown\n        run: pnpm format:md:check",
        ),
    ],
  ]) {
    await t.test(name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `zhs-parity-${name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      await writeFile(join(root, "scripts/run-b4push.sh"), sourceRunner);
      await writeFile(join(root, "scripts/check-b4push-ci-parity.mjs"), sourceChecker);
      await writeFile(join(root, ".github/workflows/ci.yml"), mutate(sourceCi));
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts/check-b4push-ci-parity.mjs")],
        {
          cwd: root,
          encoding: "utf8",
          env: subprocessEnvironment(),
        },
      );
      assert.equal(result.status, 1, result.stderr + result.stdout);
    });
  }
});

test("the minimal HTML rules reject structurally invalid permitted content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-html-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repositoryRoot, "doc/.htmlvalidate.json"), join(root, ".htmlvalidate.json"));
  const bin = join(repositoryRoot, "doc/node_modules/.bin/html-validate");
  await writeFile(
    join(root, "valid.html"),
    "<!doctype html><html><body><ul><li>ok</li></ul></body></html>\n",
  );
  await writeFile(
    join(root, "invalid.html"),
    "<!doctype html><html><body><ul><div>bad</div></ul></body></html>\n",
  );
  assert.equal(
    spawnSync(bin, ["valid.html"], { cwd: root, env: subprocessEnvironment() }).status,
    0,
  );
  const invalid = spawnSync(bin, ["invalid.html"], {
    cwd: root,
    encoding: "utf8",
    env: subprocessEnvironment(),
  });
  assert.equal(invalid.status, 1);
});
