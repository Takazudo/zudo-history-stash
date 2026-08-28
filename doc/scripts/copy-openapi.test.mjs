import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyOpenApi } from "./copy-openapi.mjs";

const VALID_OPENAPI = Buffer.from(
  `${JSON.stringify({ openapi: "3.1.0", info: { title: "fixture", version: "1.0.0" }, paths: {} }, null, 2)}\n`,
);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zhs-copy-openapi-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source: join(root, "canonical", "openapi.json"),
    destination: join(root, "public", "openapi.json"),
  };
}

async function writeCanonical(paths, bytes = VALID_OPENAPI) {
  await mkdir(join(paths.root, "canonical"), { recursive: true });
  await writeFile(paths.source, bytes);
}

test("copyOpenApi preserves canonical bytes and creates the destination", async (t) => {
  const paths = await fixture(t);
  await writeCanonical(paths);
  const sourceBefore = await stat(paths.source, { bigint: true });
  assert.deepEqual(await copyOpenApi(paths), { changed: true, bytes: VALID_OPENAPI.byteLength });
  assert.deepEqual(await readFile(paths.destination), VALID_OPENAPI);
  assert.deepEqual(await readFile(paths.source), VALID_OPENAPI);
  const sourceAfter = await stat(paths.source, { bigint: true });
  assert.equal(sourceAfter.mtimeNs, sourceBefore.mtimeNs);
});

test("copyOpenApi does not rewrite an identical destination", async (t) => {
  const paths = await fixture(t);
  await writeCanonical(paths);
  await copyOpenApi(paths);
  const before = await stat(paths.destination, { bigint: true });
  assert.deepEqual(await copyOpenApi(paths), { changed: false, bytes: VALID_OPENAPI.byteLength });
  const after = await stat(paths.destination, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
});

test("copyOpenApi keeps a good destination for missing or malformed sources", async (t) => {
  await t.test("missing source", async (t) => {
    const paths = await fixture(t);
    await mkdir(join(paths.root, "public"), { recursive: true });
    await writeFile(paths.destination, VALID_OPENAPI);
    await assert.rejects(copyOpenApi(paths), /ENOENT/);
    assert.deepEqual(await readFile(paths.destination), VALID_OPENAPI);
  });

  await t.test("malformed source", async (t) => {
    const paths = await fixture(t);
    await writeCanonical(paths, Buffer.from("{not-json\n"));
    await mkdir(join(paths.root, "public"), { recursive: true });
    await writeFile(paths.destination, VALID_OPENAPI);
    await assert.rejects(copyOpenApi(paths), /not valid JSON/);
    assert.deepEqual(await readFile(paths.destination), VALID_OPENAPI);
  });
});

test("copyOpenApi cleans temporary files and preserves the destination when rename fails", async (t) => {
  const paths = await fixture(t);
  const previous = Buffer.from(
    `${JSON.stringify({ openapi: "3.1.0", info: { title: "old", version: "0.9.0" }, paths: {} })}\n`,
  );
  await writeCanonical(paths);
  await mkdir(join(paths.root, "public"), { recursive: true });
  await writeFile(paths.destination, previous);
  await assert.rejects(
    copyOpenApi({
      ...paths,
      operations: {
        randomSuffix: () => "forced-failure",
        rename: async () => {
          throw new Error("forced rename failure");
        },
      },
    }),
    /forced rename failure/,
  );
  assert.deepEqual(await readFile(paths.destination), previous);
  assert.deepEqual(await readdir(join(paths.root, "public")), ["openapi.json"]);
});

test("copyOpenApi cleans a temporary file when writing fails and rejects path confusion", async (t) => {
  const paths = await fixture(t);
  await writeCanonical(paths);
  await assert.rejects(
    copyOpenApi({
      ...paths,
      operations: {
        randomSuffix: () => "write-failure",
        writeFile: async (path) => {
          await writeFile(path, "partial");
          throw new Error("forced write failure");
        },
      },
    }),
    /forced write failure/,
  );
  assert.deepEqual(await readdir(join(paths.root, "public")), []);
  await assert.rejects(
    copyOpenApi({ source: paths.source, destination: paths.source }),
    /must be different paths/,
  );
});
