import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeGeneratedSkillLinks } from "./normalize-generated-skill-links.mjs";

const OPTIONS = {
  generatedSkillsDir: "doc/src/content/docs/claude-skills",
  sourceSkillsDir: ".claude/skills",
  repositoryRoot: ".",
  repositoryUrl: "https://github.com/example/project",
  branch: "main",
};

test("normalizes only existing repository links in generated skill prose", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-skill-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceSkillDir = join(root, ".claude", "skills", "sample");
  const generatedDir = join(root, "doc", "src", "content", "docs", "claude-skills", "sample");
  await mkdir(sourceSkillDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });
  await mkdir(join(root, "scripts", "release"), { recursive: true });
  await writeFile(join(root, "scripts", "release.sh"), "#!/bin/sh\n");
  await writeFile(join(sourceSkillDir, "SKILL.md"), "canonical skill\n");
  const generated = `---
title: Sample
generated: true
---

[file](../../../scripts/release.sh)
[directory](../../../scripts/release/)
[generated reference](./ref-guide)
[generated script](./script-helper?raw=1)
[generated asset](./asset-logo#image)
[missing](../../../scripts/missing.sh)
[external](https://example.com/file)
[anchor](#section)

\`[inline code](../../../scripts/release.sh)\`

\`\`\`md
[fenced code](../../../scripts/release.sh)
\`\`\`
`;
  await writeFile(join(generatedDir, "index.mdx"), generated);

  const first = normalizeGeneratedSkillLinks(root, OPTIONS);
  assert.deepEqual(first, { filesChanged: 1, linksChanged: 2 });
  const result = await readFile(join(generatedDir, "index.mdx"), "utf8");
  assert.match(
    result,
    /\[file\]\(https:\/\/github\.com\/example\/project\/blob\/main\/scripts\/release\.sh\)/,
  );
  assert.match(
    result,
    /\[directory\]\(https:\/\/github\.com\/example\/project\/tree\/main\/scripts\/release\)/,
  );
  assert.match(result, /\[generated reference\]\(\.\/ref-guide\)/);
  assert.match(result, /\[generated script\]\(\.\/script-helper\?raw=1\)/);
  assert.match(result, /\[generated asset\]\(\.\/asset-logo#image\)/);
  assert.match(result, /\[missing\]\(\.\.\/\.\.\/\.\.\/scripts\/missing\.sh\)/);
  assert.match(result, /\`\[inline code\]\(\.\.\/\.\.\/\.\.\/scripts\/release\.sh\)\`/);
  assert.match(result, /\[fenced code\]\(\.\.\/\.\.\/\.\.\/scripts\/release\.sh\)/);
  assert.equal(await readFile(join(sourceSkillDir, "SKILL.md"), "utf8"), "canonical skill\n");

  assert.deepEqual(normalizeGeneratedSkillLinks(root, OPTIONS), {
    filesChanged: 0,
    linksChanged: 0,
  });
});

test("leaves hand-authored pages outside the generated contract untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-skill-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceSkillDir = join(root, ".claude", "skills", "sample");
  const generatedDir = join(root, "doc", "src", "content", "docs", "claude-skills", "sample");
  await mkdir(sourceSkillDir, { recursive: true });
  await mkdir(generatedDir, { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "release.sh"), "#!/bin/sh\n");
  await writeFile(join(sourceSkillDir, "SKILL.md"), "canonical skill\n");
  const handAuthored = "---\ntitle: Sample\n---\n\n[file](../../../scripts/release.sh)\n";
  await writeFile(join(generatedDir, "index.mdx"), handAuthored);

  assert.deepEqual(normalizeGeneratedSkillLinks(root, OPTIONS), {
    filesChanged: 0,
    linksChanged: 0,
  });
  assert.equal(await readFile(join(generatedDir, "index.mdx"), "utf8"), handAuthored);
});
