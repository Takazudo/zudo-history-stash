import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOC_BASE_PATH, OPENAPI_HREF, withDocBase } from "../src/data/site-paths.ts";
import { parseZfbConfig } from "./check-links.js";

const DOC_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("the configured base and OpenAPI asset href share one source", async () => {
  const config = await parseZfbConfig(resolve(DOC_ROOT, "zfb.config.ts"));
  const chrome = await readFile(resolve(DOC_ROOT, "src/chrome-bindings.tsx"), "utf8");

  assert.equal(config.basePath, DOC_BASE_PATH);
  assert.equal(OPENAPI_HREF, withDocBase("/openapi.json", config.basePath));
  assert.equal(OPENAPI_HREF, "/openapi.json");
  assert.equal(withDocBase("/openapi.json", "/preview/pr-165/"), "/preview/pr-165/openapi.json");
  assert.match(
    chrome,
    /function OpenApiLink\([^)]*\)[\s\S]*?return <a href=\{OPENAPI_HREF\}>\{children\}<\/a>;/,
  );
});
