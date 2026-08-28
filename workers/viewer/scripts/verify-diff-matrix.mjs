#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const VIEWER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_DIRECTORY = fileURLToPath(new URL("../test-results/diff-matrix/", import.meta.url));
const DIFF_ROUTE = "/s/notes/diff/docs/readme.txt?from=2&to=3&context=3";
const SPLIT_DESCRIPTION = "Split view needs a window wider than 56rem";
const WIDTHS = [360, 768, 1280];
const SCHEMES = ["light", "dark"];

const UNIFIED = [
  "Index: docs/readme.txt",
  "===================================================================",
  "--- a/docs/readme.txt@v2",
  "+++ b/docs/readme.txt@v3",
  "@@ -1,4 +1,3 @@",
  " shared prologue",
  "-The status is old today",
  "-obsolete line only",
  "+The status is new today",
  " shared middle",
  "@@ -20,2 +20,3 @@",
  " shared epilogue",
  "-The footer is stable",
  "+The footer is improved",
  "+new line only",
  "",
].join("\n");

const HISTORY = {
  path: "docs/readme.txt",
  headVersion: 3,
  deleted: false,
  total: 2,
  versions: [
    {
      version: 3,
      kind: "put",
      hash: "sha256-v3",
      size: 140,
      rollbackOf: null,
      author: "Ada",
      message: "Exercise every diff row kind",
      meta: {},
      createdAt: "2026-08-26T09:00:00.000Z",
    },
    {
      version: 2,
      kind: "put",
      hash: "sha256-v2",
      size: 132,
      rollbackOf: null,
      author: "Grace",
      message: "Previous matrix fixture",
      meta: {},
      createdAt: "2026-08-26T08:00:00.000Z",
    },
  ],
  nextBefore: null,
};

const DIFF = {
  state: "ready",
  unified: UNIFIED,
  truncated: false,
  stats: { added: 3, removed: 3 },
  hunks: [
    {
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 3,
      lines: [
        " shared prologue",
        "-The status is old today",
        "-obsolete line only",
        "+The status is new today",
        " shared middle",
      ],
    },
    {
      oldStart: 20,
      oldLines: 2,
      newStart: 20,
      newLines: 3,
      lines: [
        " shared epilogue",
        "-The footer is stable",
        "+The footer is improved",
        "+new line only",
      ],
    },
  ],
  from: { version: 2, hash: "sha256-v2", deleted: false },
  to: { version: 3, hash: "sha256-v3", deleted: false },
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  invariant(
    actual === expected,
    `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function normalizedExternalBaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  invariant(
    url.protocol === "http:" || url.protocol === "https:",
    `PW_BASE_URL must use http or https, received ${value}`,
  );
  return url.href.replace(/\/+$/u, "");
}

async function startVite() {
  const server = await createServer({
    root: VIEWER_ROOT,
    configFile: path.join(VIEWER_ROOT, "vite.config.ts"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite did not expose a local TCP port");
    }

    return { baseUrl: `http://127.0.0.1:${address.port}`, server };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function installApiFixture(page) {
  const unexpectedPaths = [];

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let value;

    if (pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (pathname === "/api/v1/stashes/notes/history/docs/readme.txt") {
      value = HISTORY;
    } else if (pathname === "/api/v1/stashes/notes/diff/docs/readme.txt") {
      value = DIFF;
    } else {
      unexpectedPaths.push(pathname);
      value = { error: { code: "not-found", message: "Not found" } };
    }

    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  return unexpectedPaths;
}

async function collectComputedEvidence(page, effectiveLayout) {
  return page.evaluate((layout) => {
    const resolveBackground = (property) => {
      const probe = document.createElement("span");
      probe.dataset.diffMatrixProbe = property;
      probe.style.position = "fixed";
      probe.style.inset = "auto auto 0 0";
      probe.style.width = "1px";
      probe.style.height = "1px";
      probe.style.backgroundColor = property === "transparent" ? property : `var(${property})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };

    const markEvidence = (selector) =>
      Array.from(document.querySelectorAll(selector), (mark) => {
        const style = getComputedStyle(mark);
        const boundaries = Array.from(mark.querySelectorAll(".sr-only"), (boundary) =>
          boundary.textContent?.trim(),
        );
        return {
          backgroundColor: style.backgroundColor,
          textDecorationLine: style.textDecorationLine,
          boundaries,
        };
      });

    const splitRows = Array.from(
      document.querySelectorAll(
        '[data-row-kind="changed-pair"], [data-row-kind="removed"], [data-row-kind="added"]',
      ),
      (row) => ({
        kind: row.getAttribute("data-row-kind"),
        oldGlyph: row.querySelector('[data-column="old-change"]')?.textContent?.trim() ?? "",
        newGlyph: row.querySelector('[data-column="new-change"]')?.textContent?.trim() ?? "",
      }),
    );
    const unifiedRows = Array.from(
      document.querySelectorAll('[data-line-type="remove"], [data-line-type="add"]'),
      (row) => ({
        kind: row.getAttribute("data-line-type"),
        glyph: row.querySelector('[data-column="sign"]')?.textContent?.trim() ?? "",
      }),
    );
    const appScroller = document.querySelector(".page__scroll");
    const renderedTable = document.querySelector(
      layout === "split" ? ".diff-table--split" : ".diff-table--unified",
    );

    return {
      requestedSchemeMatches: {
        light: matchMedia("(prefers-color-scheme: light)").matches,
        dark: matchMedia("(prefers-color-scheme: dark)").matches,
      },
      rootTheme: document.documentElement.dataset.theme ?? null,
      rootWidths: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      },
      bodyWidths: {
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
      },
      appScrollWidths: appScroller
        ? { clientWidth: appScroller.clientWidth, scrollWidth: appScroller.scrollWidth }
        : null,
      tokens: {
        added: resolveBackground("--theme-diff-add-mark"),
        removed: resolveBackground("--theme-diff-remove-mark"),
        transparent: resolveBackground("transparent"),
      },
      marks: {
        added: markEvidence("ins.diff-mark--added"),
        removed: markEvidence("del.diff-mark--removed"),
      },
      columnHeaders: Array.from(renderedTable?.querySelectorAll("thead th") ?? [], (header) => ({
        name: header.getAttribute("aria-label") ?? header.textContent?.trim() ?? "",
        visibleText: header.textContent?.trim() ?? "",
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
      })),
      changedRows: layout === "split" ? splitRows : unifiedRows,
    };
  }, effectiveLayout);
}

function assertComputedEvidence(evidence, { width, scheme, effectiveLayout }) {
  equal(evidence.requestedSchemeMatches.dark, scheme === "dark", `${width}px ${scheme} dark query`);
  equal(
    evidence.requestedSchemeMatches.light,
    scheme === "light",
    `${width}px ${scheme} light query`,
  );
  equal(evidence.rootTheme, scheme, `${width}px ${scheme} applied theme`);

  for (const [name, widths] of Object.entries({
    document: evidence.rootWidths,
    body: evidence.bodyWidths,
    app: evidence.appScrollWidths,
  })) {
    invariant(widths !== null, `${width}px ${scheme} ${name} scroll container is missing`);
    equal(
      widths.scrollWidth,
      widths.clientWidth,
      `${width}px ${scheme} ${name} has page-level horizontal overflow`,
    );
  }

  invariant(
    evidence.tokens.added !== evidence.tokens.transparent,
    `${width}px ${scheme} added mark token resolved transparent`,
  );
  invariant(
    evidence.tokens.removed !== evidence.tokens.transparent,
    `${width}px ${scheme} removed mark token resolved transparent`,
  );
  invariant(evidence.marks.added.length > 0, `${width}px ${scheme} has no addition marks`);
  invariant(evidence.marks.removed.length > 0, `${width}px ${scheme} has no removal marks`);
  invariant(evidence.columnHeaders.length > 0, `${width}px ${scheme} has no column headers`);
  for (const header of evidence.columnHeaders) {
    invariant(
      header.scrollWidth <= header.clientWidth + 1,
      `${width}px ${scheme} ${header.name} header overflows its column (${header.scrollWidth}px > ${header.clientWidth}px)`,
    );
  }

  for (const mark of evidence.marks.added) {
    equal(
      mark.backgroundColor,
      evidence.tokens.added,
      `${width}px ${scheme} addition mark background`,
    );
    invariant(
      mark.textDecorationLine.split(/\s+/u).includes("underline"),
      `${width}px ${scheme} addition mark is color-only`,
    );
    equal(mark.boundaries[0], "added text:", `${width}px ${scheme} addition start boundary`);
    equal(mark.boundaries.at(-1), "end of change", `${width}px ${scheme} addition end boundary`);
  }

  for (const mark of evidence.marks.removed) {
    equal(
      mark.backgroundColor,
      evidence.tokens.removed,
      `${width}px ${scheme} removal mark background`,
    );
    invariant(
      mark.textDecorationLine.split(/\s+/u).includes("line-through"),
      `${width}px ${scheme} removal mark is color-only`,
    );
    equal(mark.boundaries[0], "removed text:", `${width}px ${scheme} removal start boundary`);
    equal(mark.boundaries.at(-1), "end of change", `${width}px ${scheme} removal end boundary`);
  }

  if (effectiveLayout === "split") {
    const kinds = new Set(evidence.changedRows.map((row) => row.kind));
    for (const kind of ["changed-pair", "removed", "added"]) {
      invariant(kinds.has(kind), `${width}px ${scheme} fixture did not render a ${kind} row`);
    }
    for (const row of evidence.changedRows) {
      if (row.kind === "changed-pair" || row.kind === "removed") {
        equal(row.oldGlyph, "−", `${width}px ${scheme} ${row.kind} old-side glyph`);
      }
      if (row.kind === "changed-pair" || row.kind === "added") {
        equal(row.newGlyph, "+", `${width}px ${scheme} ${row.kind} new-side glyph`);
      }
    }
    return;
  }

  invariant(evidence.changedRows.length > 0, `${width}px ${scheme} has no changed rows`);
  for (const row of evidence.changedRows) {
    equal(row.glyph, row.kind === "add" ? "+" : "−", `${width}px ${scheme} ${row.kind} glyph`);
  }
}

async function verifyCase(browser, baseUrl, width, scheme) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

  await page.addInitScript(() => {
    sessionStorage.setItem("zhs.token", "zhs_matrix");
    localStorage.setItem("zhs.diff.layout", "split");
    localStorage.setItem("zhs.diff.marks", "true");
    localStorage.setItem("zhs.diff.wrap", "true");
  });
  const unexpectedApiPaths = await installApiFixture(page);
  await page.goto(`${baseUrl}${DIFF_ROUTE}`);

  const narrow = width <= 56 * 16;
  const effectiveLayout = narrow ? "unified" : "split";
  const tableName = effectiveLayout === "split" ? "Split diff" : "Unified diff";
  const oppositeTableName = effectiveLayout === "split" ? "Unified diff" : "Split diff";
  const table = page.getByRole("table", { name: tableName });
  const splitButton = page.getByRole("button", { name: "Split", exact: true });

  await table.waitFor({ state: "visible" });
  equal(await page.getByRole("table", { name: oppositeTableName }).count(), 0, "opposite table");
  equal(await splitButton.getAttribute("aria-pressed"), "true", `${width}px stored Split state`);
  equal(await splitButton.isDisabled(), narrow, `${width}px Split disabled state`);
  equal(
    await page.evaluate(() => localStorage.getItem("zhs.diff.layout")),
    "split",
    `${width}px stored layout`,
  );

  if (narrow) {
    await expect(splitButton).toHaveAccessibleDescription(SPLIT_DESCRIPTION);
  } else {
    equal(await splitButton.getAttribute("aria-describedby"), null, `${width}px Split description`);
  }

  await page.waitForFunction(
    (expectedTheme) => document.documentElement.dataset.theme === expectedTheme,
    scheme,
  );
  const computed = await collectComputedEvidence(page, effectiveLayout);
  assertComputedEvidence(computed, { width, scheme, effectiveLayout });
  equal(unexpectedApiPaths.length, 0, `${width}px ${scheme} unexpected API requests`);
  equal(browserErrors.length, 0, `${width}px ${scheme} browser errors`);

  return {
    context,
    page,
    table,
    browserErrors,
    result: {
      width,
      height: 900,
      requestedScheme: scheme,
      reducedMotion: "reduce",
      storedLayout: "split",
      effectiveLayout,
      splitButton: {
        pressed: true,
        disabled: narrow,
        accessibleDescription: narrow ? SPLIT_DESCRIPTION : null,
      },
      computed,
      screenshot: `diff-${width}-${scheme}.png`,
    },
  };
}

function assertThemePairs(results) {
  for (const width of WIDTHS) {
    const light = results.find(
      (result) => result.width === width && result.requestedScheme === "light",
    );
    const dark = results.find(
      (result) => result.width === width && result.requestedScheme === "dark",
    );
    invariant(light && dark, `${width}px light/dark pair is incomplete`);
    invariant(
      light.computed.tokens.added !== dark.computed.tokens.added,
      `${width}px addition mark token did not change between light and dark`,
    );
    invariant(
      light.computed.tokens.removed !== dark.computed.tokens.removed,
      `${width}px removal mark token did not change between light and dark`,
    );
  }
}

async function main() {
  const externalBaseUrl = normalizedExternalBaseUrl(process.env.PW_BASE_URL);
  const localVite = externalBaseUrl ? null : await startVite();
  const baseUrl = externalBaseUrl ?? localVite.baseUrl;
  let browser;
  const sessions = [];

  try {
    browser = await chromium.launch();
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        sessions.push(await verifyCase(browser, baseUrl, width, scheme));
      }
    }

    const results = sessions.map(({ result }) => result);
    assertThemePairs(results);
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });

    for (const session of sessions) {
      await session.table.evaluate((table) => table.scrollIntoView({ block: "start" }));
      const screenshotPath = path.join(OUTPUT_DIRECTORY, session.result.screenshot);
      await session.page.screenshot({ path: screenshotPath });
      equal(
        session.browserErrors.length,
        0,
        `${session.result.width}px ${session.result.requestedScheme} browser errors after capture`,
      );
    }

    await writeFile(
      path.join(OUTPUT_DIRECTORY, "evidence.json"),
      `${JSON.stringify(
        {
          route: DIFF_ROUTE,
          viewportHeight: 900,
          cases: results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Diff matrix passed; evidence written to ${OUTPUT_DIRECTORY}`);
  } finally {
    try {
      await browser?.close();
    } finally {
      await localVite?.server.close();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
