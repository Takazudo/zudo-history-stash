#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const VIEWER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUTPUT_DIRECTORY = fileURLToPath(
  new URL("../test-results/tone-matrix/", import.meta.url),
);
const OUTPUT_ENV = "ZHS_TONE_MATRIX_OUTPUT";
const WIDTHS = [360, 768, 1280];
const THEMES = ["dark", "light"];
const HEIGHT = 900;
const STASH = "demo";
const FILE_PATH = "docs/readme.txt";
const FILE_ROUTE = `/s/${STASH}/f/${FILE_PATH}`;
const EDIT_ROUTE = `/s/${STASH}/edit/${FILE_PATH}`;
const HASH_ONE = `sha256-${"a".repeat(64)}`;
const HASH_TWO = `sha256-${"b".repeat(64)}`;
const FILE_BODY = "# Reference\n\nCurrent viewer tone.\n";
const FILE_SIZE = new TextEncoder().encode(FILE_BODY).byteLength;

const ROUTES = [
  {
    id: "home",
    path: "/",
    rootSelector: ".page",
    activeSelector: null,
    expectsField: false,
    expectsDialog: false,
  },
  {
    id: "stash",
    path: `/s/${STASH}`,
    rootSelector: ".page",
    activeSelector: null,
    expectsField: false,
    expectsDialog: false,
  },
  {
    id: "file",
    path: FILE_ROUTE,
    rootSelector: ".page",
    activeSelector:
      '.zhs-history-table .zhs-table__row[aria-current="true"] > .zhs-table__cell:first-child',
    expectsField: true,
    expectsDialog: true,
  },
  {
    id: "edit",
    path: EDIT_ROUTE,
    rootSelector: ".zhs-edit-workbench",
    activeSelector: '.zhs-history-rail__row[aria-current="true"]',
    expectsField: true,
    expectsDialog: false,
  },
  {
    id: "tokens",
    path: `/s/${STASH}/tokens`,
    rootSelector: ".page",
    activeSelector: null,
    expectsField: true,
    expectsDialog: false,
  },
];

const FILE = {
  path: FILE_PATH,
  version: 2,
  hash: HASH_TWO,
  size: FILE_SIZE,
  kind: "put",
  author: "Ada",
  message: "Current reference copy",
  meta: {},
  createdAt: "2026-08-26T09:00:00.000Z",
  deleted: false,
  body: FILE_BODY,
};

const HISTORY = {
  path: FILE_PATH,
  headVersion: 2,
  deleted: false,
  total: 2,
  versions: [
    {
      version: 2,
      kind: "put",
      hash: HASH_TWO,
      size: FILE_SIZE,
      rollbackOf: null,
      author: "Ada",
      message: "Current reference copy",
      meta: {},
      createdAt: "2026-08-26T09:00:00.000Z",
    },
    {
      version: 1,
      kind: "put",
      hash: HASH_ONE,
      size: 21,
      rollbackOf: null,
      author: "Grace",
      message: "Initial reference copy",
      meta: {},
      createdAt: "2026-08-26T08:00:00.000Z",
    },
  ],
  nextBefore: null,
};

const CHANGE = {
  changeId: 2,
  stash: STASH,
  path: FILE_PATH,
  version: 2,
  kind: "put",
  author: "Ada",
  message: "Current reference copy",
  size: FILE_SIZE,
  createdAt: "2026-08-26T09:00:00.000Z",
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

function outputDirectory() {
  const configured = process.env[OUTPUT_ENV];
  if (configured === undefined) return DEFAULT_OUTPUT_DIRECTORY;
  invariant(configured.trim().length > 0, `${OUTPUT_ENV} must not be empty`);
  return path.resolve(configured);
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

function allowedKeys(searchParams, keys) {
  return [...searchParams].every(([key]) => keys.includes(key));
}

async function installApiFixture(page) {
  const requests = [];
  const unexpected = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;
    requests.push(signature);

    if (request.headers().authorization !== "Bearer zhs_tone_matrix") {
      unexpected.push(`${signature} without the matrix credential`);
      await route.fulfill({
        status: 401,
        json: { error: { code: "unauthorized", message: "Missing matrix credential" } },
      });
      return;
    }

    if (request.method() !== "GET") {
      unexpected.push(signature);
      await route.fulfill({
        status: 500,
        json: { error: { code: "internal", message: `Unexpected mutation: ${signature}` } },
      });
      return;
    }

    let value;
    if (url.pathname === "/api/v1/me" && url.search === "") {
      value = { principal: "admin" };
    } else if (url.pathname === "/api/v1/stashes" && url.search === "") {
      value = {
        stashes: [
          {
            name: STASH,
            description: "Tone matrix fixture",
            fileCount: 1,
            deletedFileCount: 0,
            lastChangeId: 2,
            lastChangeAt: CHANGE.createdAt,
            createdAt: "2026-08-26T08:00:00.000Z",
          },
        ],
        nextAfter: null,
      };
    } else if (url.pathname === "/api/v1/changes" && url.search === "") {
      value = { changes: [CHANGE], hasMore: false, nextBefore: null };
    } else if (
      url.pathname === `/api/v1/stashes/${STASH}/files` &&
      url.searchParams.get("includeDeleted") === "false" &&
      url.searchParams.size === 1
    ) {
      value = {
        files: [
          {
            path: FILE_PATH,
            headVersion: 2,
            hash: HASH_TWO,
            size: FILE.size,
            deleted: false,
            updatedAt: FILE.createdAt,
          },
        ],
        nextAfter: null,
      };
    } else if (url.pathname === `/api/v1/stashes/${STASH}/changes` && url.search === "") {
      value = { changes: [CHANGE], hasMore: false, nextBefore: null };
    } else if (
      url.pathname === `/api/v1/stashes/${STASH}/files/${FILE_PATH}` &&
      url.search === ""
    ) {
      value = FILE;
    } else if (
      url.pathname === `/api/v1/stashes/${STASH}/history/${FILE_PATH}` &&
      (url.search === "" ||
        (url.searchParams.size === 1 &&
          url.searchParams.has("limit") &&
          allowedKeys(url.searchParams, ["limit"])))
    ) {
      value = HISTORY;
    } else if (
      url.pathname === `/api/v1/stashes/${STASH}/diff/${FILE_PATH}` &&
      url.searchParams.has("from") &&
      url.searchParams.has("to") &&
      allowedKeys(url.searchParams, ["from", "to", "context", "maxUnifiedBytes"])
    ) {
      const from = Number.parseInt(url.searchParams.get("from") ?? "1", 10);
      const toValue = url.searchParams.get("to");
      const to = toValue === "head" ? 2 : Number.parseInt(toValue ?? "2", 10);
      value = {
        state: "same",
        unified: "",
        truncated: false,
        stats: { added: 0, removed: 0 },
        hunks: [],
        from: { version: from, hash: from === 1 ? HASH_ONE : HASH_TWO, deleted: false },
        to: { version: to, hash: to === 1 ? HASH_ONE : HASH_TWO, deleted: false },
      };
    } else if (url.pathname === `/api/v1/stashes/${STASH}/tokens` && url.search === "") {
      value = {
        tokens: [
          {
            id: "tok_tone_matrix",
            label: "viewer operator",
            scope: "write",
            createdAt: "2026-08-26T08:30:00.000Z",
            revokedAt: null,
            lastUsedAt: null,
          },
        ],
      };
    } else {
      unexpected.push(signature);
      value = { error: { code: "not-found", message: `Unexpected matrix request: ${signature}` } };
    }

    await route.fulfill({ status: "error" in value ? 500 : 200, json: value });
  });

  return { requests, unexpected };
}

async function prepareRoute(page, route) {
  if (route.id === "home") {
    await expect(page.getByRole("heading", { name: "Stashes", level: 1 })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Stash directory" })
        .getByRole("link", { name: STASH, exact: true }),
    ).toBeVisible();
    return;
  }
  if (route.id === "stash") {
    await expect(page.getByRole("heading", { name: STASH, level: 1 })).toBeVisible();
    const files = page.getByRole("region", { name: "Files" });
    await expect(files).toBeVisible();
    await expect(files.getByRole("link", { name: FILE_PATH })).toBeVisible();
    return;
  }
  if (route.id === "file") {
    await expect(page.getByRole("heading", { name: FILE_PATH, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "History" })).toBeVisible();
    await expect(page.locator('[data-history-version="2"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.getByRole("button", { name: "Delete…" }).click();
    await expect(page.getByRole("dialog", { name: `Delete ${FILE_PATH}` })).toBeVisible();
    return;
  }
  if (route.id === "edit") {
    await expect(page.getByRole("textbox", { name: "Draft body" })).toHaveValue(FILE.body);
    await expect(page.getByRole("complementary", { name: "Version history" })).toBeVisible();
    await expect(page.locator('.zhs-history-rail__row[data-history-version="2"]')).toHaveAttribute(
      "aria-current",
      "true",
    );
    return;
  }
  if (route.id === "tokens") {
    await expect(page.getByRole("heading", { name: "Tokens", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Access tokens" })).toBeVisible();
    await expect(page.getByRole("table", { name: `Tokens for ${STASH}` })).toBeVisible();
    return;
  }
  throw new Error(`No readiness contract for ${route.id}`);
}

async function collectObserved(page, route) {
  return page.evaluate(
    ({ activeSelector, rootSelector }) => {
      const measurements = (selector) =>
        Array.from(document.querySelectorAll(selector), (element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.getAttribute("class") ?? "",
          borderRadius: getComputedStyle(element).borderRadius,
        }));
      const widths = (element) =>
        element === null
          ? null
          : { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
      const active = activeSelector === null ? null : document.querySelector(activeSelector);

      return {
        storedTheme: localStorage.getItem("zhs.theme"),
        rootTheme: document.documentElement.dataset.theme ?? null,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        overflow: {
          document: widths(document.documentElement),
          body: widths(document.body),
          shell: widths(document.querySelector(".app-shell")),
          main: widths(document.querySelector(".app-main")),
          pageScroller: widths(document.querySelector(".page__scroll")),
          routeRoot: widths(document.querySelector(rootSelector)),
        },
        radii: {
          buttons: measurements("button"),
          fields: measurements(
            'input:not([type="checkbox"]):not([type="radio"]), textarea, select',
          ),
          dialogs: measurements("dialog"),
        },
        activeAccent:
          active === null
            ? null
            : {
                selector: activeSelector,
                borderColor: getComputedStyle(active).borderInlineStartColor,
                borderStyle: getComputedStyle(active).borderInlineStartStyle,
                borderWidth: getComputedStyle(active).borderInlineStartWidth,
              },
      };
    },
    { activeSelector: route.activeSelector, rootSelector: route.rootSelector },
  );
}

function assertObserved(observed, { route, width, theme, api, browserErrors }) {
  const caseName = `${route.id} ${width}px ${theme}`;
  const expectedBackground = theme === "dark" ? "rgb(28, 28, 28)" : "rgb(224, 224, 224)";
  const expectedAccent = theme === "dark" ? "rgb(174, 133, 86)" : "rgb(82, 97, 107)";
  equal(observed.storedTheme, theme, `${caseName} stored theme`);
  equal(observed.rootTheme, theme, `${caseName} applied root theme`);
  equal(observed.bodyBackground, expectedBackground, `${caseName} body background`);

  for (const [name, measurement] of Object.entries(observed.overflow)) {
    if (name === "pageScroller" && route.id === "edit") {
      equal(measurement, null, `${caseName} edit page scroller`);
      continue;
    }
    invariant(measurement !== null, `${caseName} ${name} overflow container is missing`);
    equal(
      measurement.scrollWidth,
      measurement.clientWidth,
      `${caseName} ${name} has page-level horizontal overflow`,
    );
  }

  invariant(observed.radii.buttons.length > 0, `${caseName} has no buttons to audit`);
  if (route.expectsField) {
    invariant(observed.radii.fields.length > 0, `${caseName} has no form field to audit`);
  }
  if (route.expectsDialog) {
    invariant(observed.radii.dialogs.length > 0, `${caseName} has no dialog to audit`);
  }
  for (const [kind, controls] of Object.entries(observed.radii)) {
    for (const control of controls) {
      equal(control.borderRadius, "0px", `${caseName} ${kind} ${control.tag} radius`);
    }
  }

  if (route.activeSelector !== null) {
    invariant(observed.activeAccent !== null, `${caseName} active accent target is missing`);
    equal(observed.activeAccent.borderWidth, "2px", `${caseName} active accent width`);
    equal(observed.activeAccent.borderStyle, "solid", `${caseName} active accent style`);
    equal(observed.activeAccent.borderColor, expectedAccent, `${caseName} active accent color`);
  }

  equal(api.unexpected.length, 0, `${caseName} unexpected API requests`);
  equal(browserErrors.length, 0, `${caseName} browser errors`);
}

async function verifyCase(browser, baseUrl, output, route, width, theme) {
  const id = `${route.id}-${width}-${theme}`;
  const screenshot = `${id}.png`;
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    browserErrors.push(`requestfailed: ${request.method()} ${request.url()}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      browserErrors.push(`response: ${String(response.status())} ${response.url()}`);
    }
  });
  await page.addInitScript(
    ({ storedTheme }) => {
      sessionStorage.setItem("zhs.token", "zhs_tone_matrix");
      localStorage.setItem("zhs.theme", storedTheme);
    },
    { storedTheme: theme },
  );
  const api = await installApiFixture(page);
  let observed = null;
  let failure = null;

  try {
    await page.goto(`${baseUrl}${route.path}`);
    await prepareRoute(page, route);
    await page.waitForFunction(
      (expectedTheme) => document.documentElement.dataset.theme === expectedTheme,
      theme,
    );
    observed = await collectObserved(page, route);
    assertObserved(observed, { route, width, theme, api, browserErrors });
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (observed === null) {
      try {
        observed = await collectObserved(page, route);
      } catch (collectionError) {
        observed = {
          collectionError:
            collectionError instanceof Error ? collectionError.message : String(collectionError),
        };
      }
    }
  }

  try {
    await page.screenshot({ path: path.join(output, screenshot) });
  } catch (screenshotError) {
    const message =
      screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
    failure = failure === null ? `screenshot: ${message}` : `${failure}\nscreenshot: ${message}`;
  }

  if (failure === null) {
    try {
      equal(api.unexpected.length, 0, `${id} unexpected API requests after evidence capture`);
      equal(browserErrors.length, 0, `${id} browser errors after evidence capture`);
    } catch (error) {
      failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
  }

  const apiRequests = [...api.requests];
  const unexpectedApiRequests = [...api.unexpected];
  const capturedBrowserErrors = [...browserErrors];
  try {
    await context.close();
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const teardownFailure = `context teardown: ${message}`;
    failure = failure === null ? teardownFailure : `${failure}\n${teardownFailure}`;
  }

  return {
    id,
    route: route.path,
    routeId: route.id,
    width,
    height: HEIGHT,
    theme,
    screenshot,
    expected: {
      storedTheme: theme,
      rootTheme: theme,
      bodyBackground: theme === "dark" ? "rgb(28, 28, 28)" : "rgb(224, 224, 224)",
      radius: "0px",
      activeAccent:
        route.activeSelector === null
          ? null
          : {
              width: "2px",
              style: "solid",
              color: theme === "dark" ? "rgb(174, 133, 86)" : "rgb(82, 97, 107)",
            },
      pageLevelHorizontalOverflow: false,
    },
    observed,
    apiRequests,
    unexpectedApiRequests,
    browserErrors: capturedBrowserErrors,
    stillDifferent: failure === null ? [] : [failure],
    forbidden: {
      unexpectedApiRequests,
      browserErrors: capturedBrowserErrors,
      pageLevelHorizontalOverflow: Object.values(observed?.overflow ?? {}).some(
        (measurement) => measurement !== null && measurement.scrollWidth > measurement.clientWidth,
      ),
    },
    verdict: failure === null ? "PASS" : "FAIL",
  };
}

function assertCoverage(results) {
  equal(results.length, ROUTES.length * WIDTHS.length * THEMES.length, "matrix case count");
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        invariant(
          results.some(
            (result) =>
              result.routeId === route.id && result.width === width && result.theme === theme,
          ),
          `missing matrix case ${route.id} ${String(width)}px ${theme}`,
        );
      }
    }
  }
  invariant(
    results.some((result) => (result.observed?.radii?.dialogs?.length ?? 0) > 0),
    "matrix never audited a rendered dialog",
  );
  invariant(
    results.some((result) => (result.observed?.radii?.fields?.length ?? 0) > 0),
    "matrix never audited a rendered input",
  );
  invariant(
    results.some((result) => result.observed?.activeAccent != null),
    "matrix never audited an active accent bar",
  );
}

function markdownReport(results, output, baseUrl, matrixErrors) {
  const failures = results.filter((result) => result.verdict === "FAIL");
  const rows = results
    .map(
      (result) =>
        `| ${result.routeId} | \`${result.route}\` | ${String(result.width)} | ${result.theme} | ${result.observed?.bodyBackground ?? "unavailable"} | ${result.verdict} | \`${result.screenshot}\` |`,
    )
    .join("\n");
  const differences = [
    ...failures.map(
      (result) => `- **${result.id}:** ${result.stillDifferent.join(" ").replaceAll("\n", " ")}`,
    ),
    ...matrixErrors.map((error) => `- **Matrix:** ${error.replaceAll("\n", " ")}`),
  ].join("\n");
  const hasFailures = failures.length > 0 || matrixErrors.length > 0;
  const verdict = !hasFailures
    ? `PASS — ${String(results.length)}/${String(results.length)} cases passed.`
    : `FAIL — ${String(failures.length)} case failures and ${String(matrixErrors.length)} matrix errors.`;

  return `# Viewer tone matrix evidence

Output: \`${output}\`

Base URL: \`${baseUrl}\`

Cases: ${String(results.length)} (${String(ROUTES.length)} routes × ${String(WIDTHS.length)} widths × ${String(THEMES.length)} themes)

## Expected

- Authenticated routes: \`/\`, \`/s/demo\`, \`${FILE_ROUTE}\`, \`${EDIT_ROUTE}\`, and \`/s/demo/tokens\`.
- Explicit stored \`zhs.theme\` at 360/768/1280px in dark and light.
- Body backgrounds: dark \`rgb(28, 28, 28)\`; light \`rgb(224, 224, 224)\`.
- Every rendered dialog, button, and text input/select/textarea has \`border-radius: 0px\`.
- File/history selections expose a 2px solid theme-accent start bar.
- Document, body, shell, main, page scroller, and route root have no page-level horizontal overflow.

## Observed

| Route | Path | Width | Theme | Body | Verdict | Screenshot |
| --- | --- | ---: | --- | --- | --- | --- |
${rows}

Machine-readable per-case computed styles, overflow widths, requests, errors, and verdicts are in \`evidence.json\`.

## Still different

${differences || "- None. All 30 route/width/theme cases matched the frozen contract."}

## Forbidden

- Unexpected API requests: ${String(results.reduce((count, result) => count + result.unexpectedApiRequests.length, 0))}.
- Browser console/page/network errors: ${String(results.reduce((count, result) => count + result.browserErrors.length, 0))}.
- Cases with page-level horizontal overflow: ${String(results.filter((result) => result.forbidden.pageLevelHorizontalOverflow).length)}.
- Mutating API requests: ${String(results.flatMap((result) => result.apiRequests).filter((request) => /^(?:POST|PUT|PATCH|DELETE) /u.test(request)).length)}.

## Verdict

${verdict}
`;
}

async function main() {
  const output = outputDirectory();
  await mkdir(output, { recursive: true });
  const externalBaseUrl = normalizedExternalBaseUrl(process.env.PW_BASE_URL);
  const localVite = externalBaseUrl ? null : await startVite();
  const baseUrl = externalBaseUrl ?? localVite.baseUrl;
  let browser;
  const results = [];
  const matrixErrors = [];

  try {
    browser = await chromium.launch();
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        for (const route of ROUTES) {
          results.push(await verifyCase(browser, baseUrl, output, route, width, theme));
        }
      }
    }
  } catch (error) {
    matrixErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    try {
      try {
        await browser?.close();
      } catch (error) {
        matrixErrors.push(
          `browser teardown: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    } finally {
      try {
        await localVite?.server.close();
      } catch (error) {
        matrixErrors.push(
          `Vite teardown: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  try {
    assertCoverage(results);
  } catch (error) {
    matrixErrors.push(
      `coverage: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  const failures = results.filter((result) => result.verdict === "FAIL");
  const hasFailures = failures.length > 0 || matrixErrors.length > 0;
  const evidence = {
    generatedAt: new Date().toISOString(),
    outputDirectory: output,
    outputEnvironmentVariable: OUTPUT_ENV,
    baseUrl,
    routes: ROUTES.map(({ id, path: routePath }) => ({ id, path: routePath })),
    widths: WIDTHS,
    themes: THEMES,
    expectedCaseCount: ROUTES.length * WIDTHS.length * THEMES.length,
    passCount: results.filter((result) => result.verdict === "PASS").length,
    failCount: failures.length,
    matrixErrors,
    verdict: hasFailures ? "FAIL" : "PASS",
    cases: results,
  };
  await writeFile(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(
    path.join(output, "evidence.md"),
    markdownReport(results, output, baseUrl, matrixErrors),
  );
  console.log(
    `Tone matrix ${evidence.verdict}; ${String(evidence.passCount)}/${String(results.length)} cases passed; evidence written to ${output}`,
  );
  if (hasFailures) {
    throw new Error(
      `Tone matrix failed with ${String(failures.length)} case failure(s) and ${String(matrixErrors.length)} matrix error(s); inspect ${output}`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
