import { expect, test } from "./fixtures/console-errors.js";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

test("@smoke file detail renders history and lazily requests visible stats", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const diffRequests: string[] = [];
  const versions = Array.from({ length: 60 }, (_, index) => {
    const version = 60 - index;
    return {
      version,
      kind: version === 60 ? "rollback" : version === 59 ? "delete" : "put",
      hash: version === 59 ? null : `sha256-${version}`,
      size: version === 59 ? 0 : version * 10,
      rollbackOf: version === 60 ? 2 : null,
      author: version % 2 === 0 ? "Ada" : "Grace",
      message: `Version ${version}`,
      meta: {},
      createdAt: new Date(Date.UTC(2026, 7, 25, 8, 0, version)).toISOString(),
    };
  });

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let value: object;
    if (url.pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (url.pathname === "/api/v1/stashes/notes/files/docs/readme.txt") {
      value = {
        path: "docs/readme.txt",
        version: 60,
        hash: "sha256-60",
        size: 600,
        kind: "rollback",
        author: "Ada",
        message: "Rollback to the approved copy",
        meta: {},
        createdAt: "2026-08-25T09:00:00.000Z",
        deleted: false,
        body: `Heading\n${"very-long-segment-without-a-break-".repeat(20)}\n`,
      };
    } else if (url.pathname === "/api/v1/stashes/notes/history/docs/readme.txt") {
      value = {
        path: "docs/readme.txt",
        headVersion: 60,
        deleted: false,
        total: 60,
        versions,
        nextBefore: null,
      };
    } else if (url.pathname === "/api/v1/stashes/notes/diff/docs/readme.txt") {
      diffRequests.push(url.href);
      const from = Number.parseInt(url.searchParams.get("from") ?? "1", 10);
      const requestedTo = url.searchParams.get("to");
      const to = requestedTo === "head" ? 60 : Number.parseInt(requestedTo ?? "60", 10);
      value = {
        state: "ready",
        unified: "",
        truncated: false,
        hunks: [],
        stats: { added: 2, removed: 1 },
        from: { version: from, hash: `sha256-${from}`, deleted: false },
        to: { version: to, hash: `sha256-${to}`, deleted: false },
      };
    } else {
      value = { error: { code: "not-found", message: "Not found" } };
    }
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto("/s/notes/f/docs/readme.txt");
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText("rollback", { exact: true })).toBeVisible();
  await expect(history.getByText("→ v2", { exact: true })).toBeVisible();
  await expect(history.getByText("deleted", { exact: true })).toBeVisible();

  const newestStats = history.locator('[data-history-version="60"] .history-diff-stats');
  await newestStats.scrollIntoViewIfNeeded();
  await expect(newestStats).toHaveText("+2 −1");
  await expect.poll(() => diffRequests.length).toBeGreaterThan(0);
  expect(diffRequests.length).toBeLessThan(60);

  await history.getByRole("button", { name: "Compare" }).click();
  await expect(page).toHaveURL(/\/s\/notes\/diff\/docs\/readme\.txt\?from=59&to=60$/u);
});
