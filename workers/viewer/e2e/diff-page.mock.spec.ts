import { expect, test } from "./fixtures/console-errors.js";

const UNIFIED = [
  "Index: docs/readme.txt",
  "===================================================================",
  "--- a/docs/readme.txt@v2",
  "+++ b/docs/readme.txt@v3",
  "@@ -1,3 +1,3 @@",
  " alpha",
  "-old line",
  "+new line",
  " omega",
  "",
].join("\n");

const HISTORY = {
  path: "docs/readme.txt",
  headVersion: 3,
  deleted: false,
  total: 3,
  versions: [
    {
      version: 3,
      kind: "put",
      hash: "sha256-v3",
      size: 24,
      rollbackOf: null,
      author: "Ada",
      message: "Update notes",
      meta: {},
      createdAt: "2026-08-25T09:00:00.000Z",
    },
    {
      version: 2,
      kind: "put",
      hash: "sha256-v2",
      size: 23,
      rollbackOf: null,
      author: "Ada",
      message: "Previous notes",
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
  stats: { added: 1, removed: 1 },
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [" alpha", "-old line", "+new line", " omega"],
    },
  ],
  from: { version: 2, hash: "sha256-v2", deleted: false },
  to: { version: 3, hash: "sha256-v3", deleted: false },
};

test("@smoke diff page renders structured rows and copies the unified fixture", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addInitScript(() => sessionStorage.setItem("zhs.token", "zhs_test"));
  await page.route("**/api/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const value =
      pathname === "/api/v1/me"
        ? { principal: "admin" }
        : pathname === "/api/v1/stashes/notes/history/docs/readme.txt"
          ? HISTORY
          : pathname === "/api/v1/stashes/notes/diff/docs/readme.txt"
            ? DIFF
            : { error: { code: "not-found", message: "Not found" } };
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto("/s/notes/diff/docs/readme.txt?from=2&to=head&context=3");
  const remove = page.locator('[data-line-type="remove"]');
  const add = page.locator('[data-line-type="add"]');
  await expect(remove.locator('[data-column="old"]')).toHaveText("2");
  await expect(remove.locator('[data-column="new"]')).toHaveText("");
  await expect(remove.locator('[data-column="sign"]')).toHaveText("−");
  await expect(add.locator('[data-column="old"]')).toHaveText("");
  await expect(add.locator('[data-column="new"]')).toHaveText("2");
  await expect(add.locator('[data-column="sign"]')).toHaveText("+");

  await expect(page.getByRole("checkbox", { name: "Wrap" })).toBeChecked();
  const columnHeaders = page.getByRole("table", { name: "Unified diff" }).getByRole("columnheader");
  await columnHeaders.first().scrollIntoViewIfNeeded();
  const headerMetrics = await columnHeaders.evaluateAll((headers) =>
    headers.map((header) => ({ clientWidth: header.clientWidth, scrollWidth: header.scrollWidth })),
  );
  expect(
    headerMetrics.every(({ clientWidth, scrollWidth }) => scrollWidth <= clientWidth + 1),
  ).toBe(true);

  await page.getByRole("button", { name: "Copy unified" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(UNIFIED);
});
