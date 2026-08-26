import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const ADMIN_TOKEN = process.env.STASH_ADMIN_TOKEN ?? "dev-admin-token";
const AUTHORIZATION = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const GUIDE_PATH = "docs/guide.md";

test.use({
  allowedConsoleErrors: [
    {
      pattern: /^Failed to load resource: net::ERR_CONNECTION_FAILED$/u,
      why: "The test deliberately loses the first rollback response after the upstream mutation commits.",
    },
  ],
});

interface HistoryResponse {
  total: number;
  headVersion: number;
  versions: Array<{ version: number; kind: string; rollbackOf: number | null }>;
}

async function waitForDemo(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const demo = await request.get("/api/v1/stashes/demo", {
          headers: AUTHORIZATION,
        });
        if (demo.status() !== 200) return false;

        const historyResponse = await request.get(
          "/api/v1/stashes/demo/history/docs/guide.md?limit=200",
          { headers: AUTHORIZATION },
        );
        if (historyResponse.status() !== 200) return false;

        const history = (await historyResponse.json()) as HistoryResponse;
        const seededVersions = new Set(history.versions.map(({ version }) => version));
        return (
          history.headVersion >= 4 && [1, 2, 3, 4].every((version) => seededVersions.has(version))
        );
      },
      { message: "the deterministic demo seed should be complete", timeout: 30_000 },
    )
    .toBe(true);
}

test("@live viewer renders the seeded v2 to v3 CJK and CRLF diff", async ({ page, request }) => {
  await waitForDemo(request);
  await page.addInitScript(({ token }) => sessionStorage.setItem("zhs.token", token), {
    token: ADMIN_TOKEN,
  });

  await page.goto("/s/demo/diff/docs/guide.md?from=2&to=3&context=3");

  const table = page.getByRole("table", { name: "Unified diff" });
  const removed = table.locator("del").filter({ hasText: "ガイド" }).first();
  const added = table.locator("ins").filter({ hasText: "Guide" }).first();
  await expect(table).toBeVisible();
  await expect(removed).toBeVisible();
  await expect(added).toBeVisible();
  await expect(
    page.getByText("CRLF line endings on the new side are shown normalized", { exact: true }),
  ).toBeVisible();
});

test("@live viewer composes with the stash Worker and replays one rollback", async ({
  page,
  request,
}) => {
  await waitForDemo(request);
  const initialHistoryResponse = await request.get(
    "/api/v1/stashes/demo/history/docs/guide.md?limit=200",
    { headers: AUTHORIZATION },
  );
  expect(initialHistoryResponse.status()).toBe(200);
  const initialHistory = (await initialHistoryResponse.json()) as HistoryResponse;
  const expectedRollbackVersion = initialHistory.headVersion + 1;
  const unexpectedSecondVersion = expectedRollbackVersion + 1;

  await page.goto("/login");
  await page.getByLabel("Access token").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Stashes" })).toBeVisible();

  const stashDirectory = page.getByRole("region", { name: "Stash directory" });
  await stashDirectory.getByRole("link", { name: "demo", exact: true }).click();
  const files = page.getByRole("region", { name: "Files" });
  await expect(files.getByRole("link", { name: GUIDE_PATH })).toBeVisible();
  await files.getByRole("link", { name: GUIDE_PATH }).click();

  const history = page.getByRole("region", { name: "History" });
  const seededRollback = history.locator('[data-history-version="4"]');
  await expect(seededRollback).toContainText("rollback");
  await expect(seededRollback).toContainText("→ v1");

  await page.goto("/s/demo/diff/docs/guide.md?from=1&to=2");
  const removed = page.locator('[data-line-type="remove"]');
  const added = page.locator('[data-line-type="add"]');
  await expect(removed.first()).toBeVisible();
  await expect(removed.first().locator('[data-column="sign"]')).toHaveText("−");
  await expect(added.first()).toBeVisible();
  await expect(added.first().locator('[data-column="sign"]')).toHaveText("+");

  await page.goto("/s/demo/f/docs/guide.md");
  const rollbackRequests: Array<{ key: string; upstreamStatus: number; replayed: string | null }> =
    [];
  await page.route("**/api/v1/stashes/demo/rollback/docs/guide.md", async (route) => {
    const requestHeaders = route.request().headers();
    const upstream = await route.fetch();
    rollbackRequests.push({
      key: requestHeaders["idempotency-key"] ?? "",
      upstreamStatus: upstream.status(),
      replayed: upstream.headers()["idempotent-replayed"] ?? null,
    });

    if (rollbackRequests.length === 1) {
      // The real mutation has committed; only its browser-facing response is lost.
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({ response: upstream });
  });

  await page.getByRole("button", { name: "Rollback to v2" }).click();
  const dialog = page.getByRole("dialog", { name: /Rollback .* to v2/u });
  await expect(
    dialog.getByText(`This creates v${expectedRollbackVersion} as a rollback to v2.`),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm rollback" }).click();

  const failedAttempt = dialog.getByRole("alert");
  await expect(failedAttempt).toContainText("Could not complete the rollback");
  await failedAttempt.getByRole("button", { name: "Try again" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".file-body-pane")).toContainText("履歴を安全に確認できるデモです。");
  const completedRollback = page
    .getByRole("region", { name: "History" })
    .locator(`[data-history-version="${expectedRollbackVersion}"]`);
  await expect(completedRollback).toContainText("rollback");
  await expect(completedRollback).toContainText("→ v2");
  await expect(page.locator(`[data-history-version="${unexpectedSecondVersion}"]`)).toHaveCount(0);

  expect(rollbackRequests).toHaveLength(2);
  expect(rollbackRequests[0]).toMatchObject({ upstreamStatus: 201, replayed: null });
  expect(rollbackRequests[0]?.key).not.toBe("");
  expect(rollbackRequests[1]).toMatchObject({
    key: rollbackRequests[0]?.key,
    upstreamStatus: 201,
    replayed: "true",
  });

  const persistedHistoryResponse = await request.get(
    "/api/v1/stashes/demo/history/docs/guide.md?limit=200",
    { headers: AUTHORIZATION },
  );
  expect(persistedHistoryResponse.status()).toBe(200);
  const persistedHistory = (await persistedHistoryResponse.json()) as HistoryResponse;
  expect(persistedHistory.headVersion).toBe(expectedRollbackVersion);
  expect(persistedHistory.total).toBe(initialHistory.total + 1);
  expect(persistedHistory.versions[0]).toMatchObject({
    version: expectedRollbackVersion,
    kind: "rollback",
    rollbackOf: 2,
  });
});
