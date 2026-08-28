import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHtmlLinksAndTrailing, extractHtmlIds, extractHtmlLinks } from "./check-links.js";

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
