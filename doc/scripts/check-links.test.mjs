import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkHtmlLinksAndTrailing,
  checkMdxAnchors,
  checkMdxLinks,
  extractHtmlIds,
  extractHtmlLinks,
  parseZfbConfig,
} from "./check-links.js";

test("extractHtmlLinks accepts quoted and valid unquoted href attributes", () => {
  const html = [
    '<a href="double/">double</a>',
    "<a href='single/'>single</a>",
    "<a class=x HREF = unquoted/path?flag#ok>unquoted</a>",
    "<a data-href=decoy>no href</a>",
    "<a href=https://example.com/>external</a>",
    "<!-- <a href=comment-only>comment</a> -->",
    "<script>const fake = '<a href=script-only>script</a>';</script>",
    "<style>.fake::after { content: '<a href=style-only>'; }</style>",
    "<template><a href=template-only>template</a></template>",
    "<a title='1 > 0' href=after-quoted-greater>after quoted greater</a>",
  ].join("\n");

  assert.deepEqual(extractHtmlLinks(html), [
    { href: "double/", line: 1 },
    { href: "single/", line: 2 },
    { href: "unquoted/path?flag#ok", line: 3 },
    { href: "after-quoted-greater", line: 10 },
  ]);
});

test("extractHtmlIds accepts quoted and valid unquoted id attributes", () => {
  const html = [
    '<h2 id="double">double</h2>',
    "<h2 id='single'>single</h2>",
    "<h2 class=x ID = unquoted>unquoted</h2>",
    "<h2 data-id=decoy>no id</h2>",
    "<!-- <h2 id=comment-only>comment</h2> -->",
    "<script>const fake = '<h2 id=script-only>script</h2>';</script>",
    "<style>.fake::after { content: '<h2 id=style-only>'; }</style>",
    "<template><h2 id=template-only>template</h2></template>",
    "<h2 title='1 > 0' id=after-quoted-greater>after quoted greater</h2>",
  ].join("\n");
  assert.deepEqual(
    [...extractHtmlIds(html)],
    ["double", "single", "unquoted", "after-quoted-greater"],
  );
});

test("the dist checker rejects and then resolves an unquoted href", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-check-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<a href=missing/path#present>missing</a>\n");

  const missing = await checkHtmlLinksAndTrailing(dist, root);
  assert.deepEqual(missing.broken, [
    { file: "dist/index.html", line: 1, href: "missing/path#present" },
  ]);

  await mkdir(join(dist, "missing", "path"), { recursive: true });
  await writeFile(join(dist, "missing", "path", "index.html"), "<h2 id=present>present</h2>\n");
  const present = await checkHtmlLinksAndTrailing(dist, root);
  assert.deepEqual(present.broken, []);
  assert.deepEqual(present.anchors, []);
});

test("source checks reject absolute Docs paths and invalid anchors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-check-source-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docs = join(root, "src/content/docs");
  await mkdir(docs, { recursive: true });
  await writeFile(
    join(docs, "index.mdx"),
    "[absolute](/docs/target)\n[bad anchor](./target.mdx#missing)\n",
  );
  await writeFile(join(docs, "target.mdx"), "## Present heading\n");

  assert.deepEqual(await checkMdxLinks([docs], root, null, "/", []), [
    { file: "src/content/docs/index.mdx", line: 1, href: "/docs/target" },
  ]);
  assert.deepEqual(await checkMdxAnchors([docs], root, "/", []), [
    {
      file: "src/content/docs/index.mdx",
      line: 2,
      href: "./target.mdx#missing",
      fragment: "missing",
      reason: "missing target id",
    },
  ]);

  await writeFile(
    join(docs, "index.mdx"),
    "[relative](./target.mdx)\n[good anchor](./target.mdx#present-heading)\n",
  );
  assert.deepEqual(await checkMdxLinks([docs], root, null, "/", []), []);
  assert.deepEqual(await checkMdxAnchors([docs], root, "/", []), []);
});

test("parseZfbConfig resolves one relative imported string constant without executing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhs-check-config-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src/data"), { recursive: true });
  await writeFile(
    join(root, "zfb.config.ts"),
    [
      'import { DOC_BASE_PATH } from "./src/data/site-paths.ts";',
      "zudoDoc({ base: DOC_BASE_PATH });",
      "",
    ].join("\n"),
  );
  await writeFile(join(root, "src/data/site-paths.ts"), 'export const DOC_BASE_PATH = "/docs/";\n');

  assert.equal((await parseZfbConfig(join(root, "zfb.config.ts"))).basePath, "/docs/");

  await writeFile(
    join(root, "src/data/site-paths.ts"),
    "export const DOC_BASE_PATH = process.env.DOC_BASE_PATH;\n",
  );
  await assert.rejects(
    parseZfbConfig(join(root, "zfb.config.ts")),
    /imported constant must be a literal string/,
  );
});
