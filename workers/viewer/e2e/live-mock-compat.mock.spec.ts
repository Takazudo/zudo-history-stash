import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

interface MockLiveSnapshot {
  opened: number;
  aborted: number;
  canceled: number;
  active: number;
}

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

function mockLiveSnapshot(page: Page): Promise<MockLiveSnapshot> {
  return page.evaluate(() => {
    const instrumentation = (
      window as typeof window & {
        __zhsMockLiveEvents?: { snapshot(): MockLiveSnapshot };
      }
    ).__zhsMockLiveEvents;
    if (instrumentation === undefined)
      throw new Error("mock live instrumentation was not installed");
    return instrumentation.snapshot();
  });
}

test("@smoke shared mock live transport stays open and releases on stash navigation", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const unexpectedRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;
    let value: object | undefined;
    if (request.method() === "GET" && url.pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (request.method() === "GET" && url.pathname === "/api/v1/stashes/notes/files") {
      value = { files: [], nextAfter: null };
    } else if (request.method() === "GET" && url.pathname === "/api/v1/stashes/notes/changes") {
      value = { changes: [], hasMore: false, nextBefore: null };
    } else if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/stashes/notes/change-sets" &&
      url.search === "?status=open&limit=1"
    ) {
      value = { changeSets: [], nextAfter: null, total: 0 };
    } else if (request.method() === "GET" && url.pathname === "/api/v1/stashes") {
      value = { stashes: [], nextAfter: null };
    } else if (request.method() === "GET" && url.pathname === "/api/v1/changes") {
      value = { changes: [], hasMore: false, nextBefore: null };
    } else if (request.method() === "GET" && url.pathname === "/api/v1/admin/gc/runs") {
      value = { runs: [] };
    }

    if (value !== undefined) {
      await route.fulfill({ status: 200, json: value });
      return;
    }
    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: `Unexpected mock request: ${signature}` } },
    });
  });

  await page.goto("/s/notes");
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Live updates: reconnecting" })).toBeVisible();
  await expect.poll(async () => (await mockLiveSnapshot(page)).active).toBe(1);
  expect((await mockLiveSnapshot(page)).opened).toBeGreaterThan(0);
  expect(unexpectedRequests).toEqual([]);

  await page.getByRole("link", { name: "History Stash" }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Stashes" })).toBeVisible();
  await expect.poll(async () => (await mockLiveSnapshot(page)).active).toBe(0);
  const released = await mockLiveSnapshot(page);
  expect(released.aborted + released.canceled).toBeGreaterThan(0);
  expect(unexpectedRequests).toEqual([]);
});
