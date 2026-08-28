import { expect, test } from "./fixtures/console-errors.js";

const TOKEN = process.env.PW_STASH_TOKEN;
if (!TOKEN || !/^zhs_[A-Za-z0-9_-]+$/u.test(TOKEN)) {
  throw new Error("preview smoke requires PW_STASH_TOKEN");
}

const GUIDE_BODY = "# Guide\n\nWelcome to the History Stash demo.\n";

test.use({ mockLiveEvents: false });

test("@preview read-only token opens the seeded guide and its history", async ({ page }) => {
  const meResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/v1/me",
  );
  const filesResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/stashes/demo/files",
  );

  await page.goto("/login");
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Continue" }).click();

  const [me, files] = await Promise.all([meResponse, filesResponse]);
  expect(me.status()).toBe(200);
  expect(me.headers()["content-type"]).toMatch(/^application\/json\b/u);
  expect(await me.json()).toMatchObject({ principal: "stash", scope: "read", stash: "demo" });
  expect(files.status()).toBe(200);
  await expect(page).toHaveURL(/\/s\/demo$/u);
  const fileList = page.getByRole("region", { name: "Files" });
  await expect(fileList.getByRole("link", { name: "docs/guide.md", exact: true })).toBeVisible();

  const fileResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/stashes/demo/files/docs/guide.md" &&
      new URL(response.url()).search === "",
  );
  const historyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/stashes/demo/history/docs/guide.md",
  );
  await fileList.getByRole("link", { name: "docs/guide.md", exact: true }).click();
  const [file, history] = await Promise.all([fileResponse, historyResponse]);
  expect(file.status()).toBe(200);
  expect(history.status()).toBe(200);

  await expect(page).toHaveURL(/\/s\/demo\/f\/docs\/guide\.md$/u);
  await expect(page.getByRole("heading", { name: "docs/guide.md", level: 1 })).toBeVisible();
  const body = page.locator(".file-body-pane");
  await expect(body).toBeVisible();
  expect(await body.textContent()).toBe(GUIDE_BODY);

  const versionHistory = page.getByRole("region", { name: "History" });
  await expect(versionHistory).toContainText("4 versions, newest first.");
  await expect(versionHistory.locator('[data-history-version="4"]')).toContainText("rollback");
  await expect(versionHistory.locator('[data-history-version="1"]')).toBeVisible();

  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete…" })).toHaveCount(0);
  const rollbackControls = versionHistory.getByRole("button", { name: /Rollback to v/u });
  await expect(rollbackControls).toHaveCount(4);
  for (const control of await rollbackControls.all()) {
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("title", "Write access is required");
  }
});
