import { expect, test } from "./fixtures/console-errors.js";

test("@smoke login renders the token form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Open History Stash" })).toBeVisible();
  await expect(page.getByLabel("Access token")).toBeVisible();
});

test("@smoke protected deep links preserve next", async ({ page }) => {
  await page.goto("/s/x");
  await expect(page).toHaveURL(/\/login\?next=%2Fs%2Fx$/u);
});

test("@smoke unsafe next falls back to the principal home", async ({ page }) => {
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ principal: "admin" }),
    });
  });

  await page.goto("/login?next=//evil.example");
  await page.getByLabel("Access token").fill("zhs_test");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByRole("heading", { name: "Stashes" })).toBeVisible();
});
