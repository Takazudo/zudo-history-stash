import { expect, test } from "./fixtures/console-errors.js";
import { fulfillEmptyOpenProposalCount } from "./fixtures/proposal-count.js";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

test("@smoke login returns to the protected deep link", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillEmptyOpenProposalCount(route, [{ stash: "notes" }])) return;
    const pathname = new URL(route.request().url()).pathname;
    const value =
      pathname === "/api/v1/me"
        ? { principal: "stash", stash: "notes", tokenId: "tok_1", scope: "read" }
        : pathname === "/api/v1/stashes/notes/files"
          ? { files: [], nextAfter: null }
          : pathname === "/api/v1/stashes/notes/changes"
            ? { changes: [], hasMore: false, nextBefore: null }
            : { error: { code: "not-found", message: "Not found" } };
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto("/s/notes");
  await expect(page).toHaveURL(/\/login\?next=%2Fs%2Fnotes$/u);
  await page.getByLabel("Access token").fill("zhs_notes");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/s\/notes$/u);
  await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
});

test("@smoke admin stash list shows counts and recent changes newest-first", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const gcRunQueries: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/v1/admin/gc/runs") gcRunQueries.push(url.search);
    const value =
      pathname === "/api/v1/me"
        ? { principal: "admin" }
        : pathname === "/api/v1/stashes"
          ? {
              stashes: [
                {
                  name: "notes",
                  description: "Team notes",
                  fileCount: 2,
                  deletedFileCount: 1,
                  lastChangeId: 9,
                  lastChangeAt: "2026-08-25T09:00:00.000Z",
                  createdAt: "2026-08-20T09:00:00.000Z",
                },
              ],
              nextAfter: null,
            }
          : pathname === "/api/v1/changes"
            ? {
                changes: [
                  {
                    changeId: 3,
                    stash: "notes",
                    path: "older.txt",
                    version: 1,
                    kind: "put",
                    author: "Ada",
                    message: "Older",
                    size: 10,
                    createdAt: "2026-08-25T07:00:00.000Z",
                  },
                  {
                    changeId: 9,
                    stash: "notes",
                    path: "newer.txt",
                    version: 3,
                    kind: "rollback",
                    author: "Grace",
                    message: "Newest",
                    size: 20,
                    createdAt: "2026-08-25T09:00:00.000Z",
                  },
                ],
                hasMore: false,
                nextBefore: null,
              }
            : pathname === "/api/v1/admin/gc/runs"
              ? { runs: [] }
              : { error: { code: "not-found", message: "Not found" } };
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto("/");
  const stashRow = page.getByRole("row").filter({ has: page.getByRole("link", { name: "notes" }) });
  await expect(stashRow).toContainText("2");
  await expect(stashRow).toContainText("+ 1 deleted");
  const changes = page.getByRole("region", { name: "Recent changes" }).getByRole("listitem");
  await expect(changes).toHaveCount(2);
  await expect(changes.nth(0)).toHaveAttribute("data-change-id", "9");
  await expect(changes.nth(1)).toHaveAttribute("data-change-id", "3");
  await expect.poll(() => gcRunQueries.length).toBeGreaterThan(0);
  expect(new Set(gcRunQueries)).toEqual(new Set(["?kind=r2-orphans&limit=10"]));
});

test("@smoke file list appends without duplicates and re-queries deleted files", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const fileRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillEmptyOpenProposalCount(route, [{ stash: "notes" }])) return;
    const url = new URL(route.request().url());
    let value: object;
    if (url.pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (url.pathname === "/api/v1/stashes/notes/changes") {
      value = { changes: [], hasMore: false, nextBefore: null };
    } else if (url.pathname === "/api/v1/stashes/notes/files") {
      fileRequests.push(url.search);
      if (url.searchParams.get("includeDeleted") === "true") {
        value = {
          files: [
            {
              path: "archive/deleted.txt",
              headVersion: 4,
              hash: null,
              size: 0,
              deleted: true,
              updatedAt: "2026-08-25T09:00:00.000Z",
            },
          ],
          nextAfter: null,
        };
      } else if (url.searchParams.get("after") === "folder/b.txt") {
        value = {
          files: [
            {
              path: "folder/b.txt",
              headVersion: 2,
              hash: "sha256-b",
              size: 20,
              deleted: false,
              updatedAt: "2026-08-25T08:00:00.000Z",
            },
            {
              path: "folder/c.txt",
              headVersion: 3,
              hash: "sha256-c",
              size: 30,
              deleted: false,
              updatedAt: "2026-08-25T09:00:00.000Z",
            },
          ],
          nextAfter: null,
        };
      } else {
        value = {
          files: [
            {
              path: "folder/a.txt",
              headVersion: 1,
              hash: "sha256-a",
              size: 10,
              deleted: false,
              updatedAt: "2026-08-25T07:00:00.000Z",
            },
            {
              path: "folder/b.txt",
              headVersion: 2,
              hash: "sha256-b",
              size: 20,
              deleted: false,
              updatedAt: "2026-08-25T08:00:00.000Z",
            },
          ],
          nextAfter: "folder/b.txt",
        };
      }
    } else {
      value = { error: { code: "not-found", message: "Not found" } };
    }
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto("/s/notes");
  const files = page.getByRole("region", { name: "Files" });
  await expect(files.getByRole("link", { name: "folder/a.txt" })).toBeVisible();
  await files.getByRole("button", { name: "Load more" }).click();
  await expect(files.getByRole("link", { name: "folder/c.txt" })).toBeVisible();
  await expect(files.getByRole("link", { name: "folder/b.txt" })).toHaveCount(1);

  await files.getByRole("checkbox", { name: "Include deleted" }).check();
  await expect(files.getByRole("link", { name: "archive/deleted.txt" })).toBeVisible();
  expect(
    fileRequests.some((query) => new URLSearchParams(query).get("includeDeleted") === "true"),
  ).toBeTruthy();
});
