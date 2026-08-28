import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareGeneratedTree,
  generatorArguments,
  parseTemplateAllowlist,
} from "./check-template-drift.mjs";

async function treeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhs-template-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = join(root, "generated");
  const live = join(root, "live");
  await mkdir(join(generated, "nested"), { recursive: true });
  await mkdir(join(live, "nested"), { recursive: true });
  await writeFile(join(generated, "managed.txt"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(live, "managed.txt"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(generated, "nested/adapted.txt"), "generator\n");
  await writeFile(join(live, "nested/adapted.txt"), "project\n");
  await symlink("managed.txt", join(generated, "managed-link"));
  await symlink("managed.txt", join(live, "managed-link"));
  const allowlist = join(root, "allowlist");
  await writeFile(allowlist, "nested/adapted.txt :: project-owned adaptation\n");
  return { root, generated, live, allowlist };
}

test("template comparison is byte-exact, symlink-safe, and read-only", async (t) => {
  const fixture = await treeFixture(t);
  const beforeBytes = await readFile(join(fixture.live, "managed.txt"));
  const beforeStat = await lstat(join(fixture.live, "managed.txt"));
  assert.deepEqual(await compareGeneratedTree(fixture.generated, fixture.live, fixture.allowlist), {
    compared: 2,
    allowlisted: 1,
  });
  assert.deepEqual(await readFile(join(fixture.live, "managed.txt")), beforeBytes);
  assert.equal((await lstat(join(fixture.live, "managed.txt"))).mtimeMs, beforeStat.mtimeMs);
});

test("template comparison rejects changed and missing managed files", async (t) => {
  await t.test("changed", async (t) => {
    const fixture = await treeFixture(t);
    await writeFile(join(fixture.live, "managed.txt"), "changed\n");
    await assert.rejects(
      compareGeneratedTree(fixture.generated, fixture.live, fixture.allowlist),
      /managed\.txt: generator-owned bytes differ/,
    );
  });
  await t.test("missing", async (t) => {
    const fixture = await treeFixture(t);
    await rm(join(fixture.live, "managed.txt"));
    await assert.rejects(
      compareGeneratedTree(fixture.generated, fixture.live, fixture.allowlist),
      /managed\.txt: generator-owned file is missing/,
    );
  });
});

test("template allowlist rejects unsafe, broad, duplicate, unexplained, stale, and identical entries", async () => {
  const entries = new Map([
    ["file.txt", {}],
    ["nested/file.txt", {}],
  ]);
  const directories = new Set(["nested"]);
  for (const [source, diagnostic] of [
    ["*.txt :: broad", /not an exact safe file path/],
    ["../file.txt :: escape", /not an exact safe file path/],
    ["nested/ :: broad", /not an exact safe file path/],
    ["nested :: directory", /must name a file/],
    ["file.txt", /needs an exact path and nearby reason/],
    ["file.txt :: ", /needs an exact path and nearby reason|has no reason/],
    ["missing.txt :: stale", /stale allowlist entry/],
    ["file.txt :: first\nfile.txt :: second", /duplicate allowlist entry/],
  ]) {
    assert.throws(() => parseTemplateAllowlist(source, entries, directories), diagnostic);
  }

  const t = { after() {} };
  const fixture = await treeFixture(t);
  await writeFile(join(fixture.live, "nested/adapted.txt"), "generator\n");
  await assert.rejects(
    compareGeneratedTree(fixture.generated, fixture.live, fixture.allowlist),
    /allowlist entry is stale because bytes now match/,
  );
  await rm(fixture.root, { recursive: true, force: true });
});

test("generator invocation always disables install and Git initialization", () => {
  const args = generatorArguments("/tmp/preset.json");
  assert.deepEqual(args, ["doc", "--preset", "/tmp/preset.json", "--no-install", "--no-git"]);
});
