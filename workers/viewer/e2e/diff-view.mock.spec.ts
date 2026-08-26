import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const LONG_LINE = "L".repeat(2_048);

const UNIFIED = [
  "Index: docs/readme.txt",
  "===================================================================",
  "--- a/docs/readme.txt@v2",
  "+++ b/docs/readme.txt@v3",
  "@@ -1,3 +1,3 @@",
  " unchanged opening",
  "-The status is old today",
  "+The status is new today",
  ` ${LONG_LINE}`,
  "@@ -20,1 +20,1 @@",
  "-猫です",
  NO_NEWLINE_MARKER,
  "+犬です",
  NO_NEWLINE_MARKER,
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
      size: 2_200,
      rollbackOf: null,
      author: "Ada",
      message: "Update the document",
      meta: {},
      createdAt: "2026-08-25T09:00:00.000Z",
    },
    {
      version: 2,
      kind: "put",
      hash: "sha256-v2",
      size: 2_200,
      rollbackOf: null,
      author: "Grace",
      message: "Previous document",
      meta: {},
      createdAt: "2026-08-25T08:00:00.000Z",
    },
  ],
  nextBefore: null,
};

const DIFF = {
  state: "ready",
  unified: UNIFIED,
  truncated: false,
  stats: { added: 2, removed: 2 },
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        " unchanged opening",
        "-The status is old today",
        "+The status is new today",
        ` ${LONG_LINE}`,
      ],
    },
    {
      oldStart: 20,
      oldLines: 1,
      newStart: 20,
      newLines: 1,
      lines: ["-猫です", NO_NEWLINE_MARKER, "+犬です", NO_NEWLINE_MARKER],
    },
  ],
  from: { version: 2, hash: "sha256-v2", deleted: false },
  to: { version: 3, hash: "sha256-v3", deleted: false },
};

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

async function mockDiffApi(page: Page): Promise<() => number> {
  let diffRequestCount = 0;

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let value: object;

    if (pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (pathname === "/api/v1/stashes/notes/history/docs/readme.txt") {
      value = HISTORY;
    } else if (pathname === "/api/v1/stashes/notes/diff/docs/readme.txt") {
      diffRequestCount += 1;
      value = DIFF;
    } else {
      value = { error: { code: "not-found", message: "Not found" } };
    }

    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  return () => diffRequestCount;
}

async function expectContainedHorizontalOverflow(page: Page): Promise<void> {
  const pane = page.locator(".diff-table-pane");
  await expect(pane).toBeVisible();
  await expect
    .poll(() => pane.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);

  const documentWidths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(documentWidths.scrollWidth).toBe(documentWidths.clientWidth);
}

test("@smoke diff view switches layout and display preferences without refetching", async ({
  page,
}) => {
  expect(LONG_LINE.length).toBeGreaterThanOrEqual(2_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1_280, height: 900 });
  await page.addInitScript(tokenScript);
  const diffRequestCount = await mockDiffApi(page);

  await page.goto("/s/notes/diff/docs/readme.txt?from=2&to=head&context=3");

  const unifiedTable = page.getByRole("table", { name: "Unified diff" });
  await expect(unifiedTable).toBeVisible();
  await expect(unifiedTable).toHaveClass(/\bdiff-table--unified\b/u);
  await expect.poll(diffRequestCount).toBeGreaterThan(0);
  const readyRequestCount = diffRequestCount();

  const englishRemoved = unifiedTable.locator("del").filter({ hasText: "old" });
  const englishAdded = unifiedTable.locator("ins").filter({ hasText: "new" });
  const cjkRemoved = unifiedTable.locator("del").filter({ hasText: "猫" });
  const cjkAdded = unifiedTable.locator("ins").filter({ hasText: "犬" });
  await expect(englishRemoved).toHaveCount(1);
  await expect(englishAdded).toHaveCount(1);
  await expect(cjkRemoved).toHaveCount(1);
  await expect(cjkAdded).toHaveCount(1);
  await expect(cjkRemoved.locator(".sr-only").first()).toContainText("removed text:");
  await expect(cjkRemoved.locator(".sr-only").last()).toHaveText("end of change");
  await expect(cjkAdded.locator(".sr-only").first()).toContainText("added text:");
  await expect(cjkAdded.locator(".sr-only").last()).toHaveText("end of change");

  await page.getByRole("button", { name: "Split" }).click();
  const splitTable = page.getByRole("table", { name: "Split diff" });
  await expect(splitTable).toBeVisible();
  await expect(splitTable).toHaveClass(/\bdiff-table--split\b/u);
  await expect(page.getByRole("table", { name: "Unified diff" })).toHaveCount(0);
  await expect(
    splitTable.locator('[data-row-kind="no-newline"] [data-marker-side="both"]'),
  ).toHaveCount(1);

  await page.getByRole("checkbox", { name: "Marks" }).uncheck();
  const unstyledCjkRemoved = splitTable.locator("del").filter({ hasText: "猫" });
  const unstyledCjkAdded = splitTable.locator("ins").filter({ hasText: "犬" });
  await expect(unstyledCjkRemoved).toHaveCount(1);
  await expect(unstyledCjkAdded).toHaveCount(1);
  await expect(unstyledCjkRemoved).toHaveCSS("text-decoration-line", "none");
  await expect(unstyledCjkAdded).toHaveCSS("text-decoration-line", "none");

  await page.getByRole("checkbox", { name: "Wrap" }).uncheck();
  await expect(page.locator(".diff-table-pane")).toHaveAttribute("data-wrap", "off");
  await expectContainedHorizontalOverflow(page);

  await page.getByRole("button", { name: "Copy unified" }).click();
  await expect(page.getByRole("status")).toContainText("Copied to clipboard.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(UNIFIED);
  expect(diffRequestCount()).toBe(readyRequestCount);
});

test("@smoke diff view restores stored split only above the responsive boundary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.addInitScript(() => {
    sessionStorage.setItem("zhs.token", "zhs_test");
    localStorage.setItem("zhs.diff.layout", "split");
    localStorage.setItem("zhs.diff.wrap", "false");
  });
  const diffRequestCount = await mockDiffApi(page);

  await page.goto("/s/notes/diff/docs/readme.txt?from=2&to=head&context=3");
  const splitButton = page.getByRole("button", { name: "Split" });
  const wrap = page.getByRole("checkbox", { name: "Wrap" });

  await expect(page.getByRole("table", { name: "Unified diff" })).toBeVisible();
  await expect.poll(diffRequestCount).toBeGreaterThan(0);
  const readyRequestCount = diffRequestCount();
  expect(await page.evaluate(() => localStorage.getItem("zhs.diff.layout"))).toBe("split");
  await expect(splitButton).toBeDisabled();
  await expect(splitButton).toHaveAttribute("aria-pressed", "true");
  await expect(splitButton).toHaveAccessibleDescription(
    "Split view needs a window wider than 56rem",
  );
  await expect(wrap).not.toBeChecked();
  await expectContainedHorizontalOverflow(page);
  expect(diffRequestCount()).toBe(readyRequestCount);

  for (const width of [768, 895]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("table", { name: "Unified diff" })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("zhs.diff.layout"))).toBe("split");
    await expect(splitButton).toBeDisabled();
    await expect(splitButton).toHaveAttribute("aria-pressed", "true");
    await expect(splitButton).toHaveAccessibleDescription(
      "Split view needs a window wider than 56rem",
    );
    await expectContainedHorizontalOverflow(page);
    expect(diffRequestCount()).toBe(readyRequestCount);
  }

  await page.setViewportSize({ width: 897, height: 900 });
  await expect(page.getByRole("table", { name: "Split diff" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("zhs.diff.layout"))).toBe("split");
  await expect(splitButton).toBeEnabled();
  await expect(splitButton).toHaveAttribute("aria-pressed", "true");
  await expect(splitButton).not.toHaveAttribute("aria-describedby", /.+/u);
  await expectContainedHorizontalOverflow(page);
  expect(diffRequestCount()).toBe(readyRequestCount);
});
