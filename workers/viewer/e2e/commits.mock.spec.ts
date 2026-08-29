import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";
import {
  FIXTURE_COMMIT_ID,
  FIXTURE_STASH,
  changeItem,
  commitDiff,
  commitRecord,
  currentFor,
  fileRecordFor,
} from "./fixtures/history-fixtures.js";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_e2e_admin");

test.use({
  allowedConsoleErrors: [
    {
      pattern:
        /^Failed to load resource: the server responded with a status of 409(?: \(Conflict\))?$/u,
      why: "The revert mock intentionally returns the typed commit-conflict response.",
    },
  ],
});

function jsonBody(request: Request): unknown {
  const body = request.postData();
  return body === null ? null : (JSON.parse(body) as unknown);
}

async function installCommitFixture(page: Page) {
  const commit = commitRecord();
  const diff = commitDiff(commit);
  const revertRequests: unknown[] = [];
  const unexpectedRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const signature = `${method} ${url.pathname}${url.search}`;

    if (method === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (method === "GET" && url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/files`) {
      await route.fulfill({
        status: 200,
        json: { files: [], nextAfter: null },
      });
      return;
    }

    if (method === "GET" && url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/changes`) {
      await route.fulfill({
        status: 200,
        json: {
          changes: [changeItem(0), changeItem(1), changeItem(2)],
          hasMore: false,
          nextBefore: null,
        },
      });
      return;
    }

    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/change-sets` &&
      url.searchParams.get("status") === "open"
    ) {
      await route.fulfill({ status: 200, json: { changeSets: [], nextAfter: null, total: 0 } });
      return;
    }

    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/commits/${FIXTURE_COMMIT_ID}`
    ) {
      await route.fulfill({ status: 200, json: commit });
      return;
    }

    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/commits/${FIXTURE_COMMIT_ID}/diff`
    ) {
      await route.fulfill({ status: 200, json: diff });
      return;
    }

    if (method === "GET" && url.pathname.startsWith(`/api/v1/stashes/${FIXTURE_STASH}/files/`)) {
      const path = decodeURIComponent(
        url.pathname.slice(`/api/v1/stashes/${FIXTURE_STASH}/files/`.length),
      );
      const index = commit.entries.findIndex((entry) => entry.path === path);
      if (index !== -1) {
        await route.fulfill({ status: 200, json: fileRecordFor(commit.entries[index]!, index) });
        return;
      }
    }

    if (
      method === "POST" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/commits/${FIXTURE_COMMIT_ID}/revert`
    ) {
      revertRequests.push(jsonBody(request));
      await route.fulfill({
        status: 409,
        json: {
          error: { code: "commit-conflict", message: "Commit heads changed." },
          conflicts: [
            {
              path: commit.entries[0]!.path,
              expectedVersion: commit.entries[0]!.version,
              current: currentFor(0, commit.entries[0]!.version + 1),
            },
          ],
        },
      });
      return;
    }

    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 404,
      json: { error: { code: "not-found", message: `Unexpected mock request: ${signature}` } },
    });
  });

  return { commit, revertRequests, unexpectedRequests };
}

test("@smoke commit detail renders all three diffs from the API-shaped fixture", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const fixture = await installCommitFixture(page);

  await page.goto(`/s/${FIXTURE_STASH}/commits/${FIXTURE_COMMIT_ID}`);
  await expect(page.getByRole("heading", { name: fixture.commit.message })).toBeVisible();
  const diffs = page.locator("[data-diff-path]");
  await expect(diffs).toHaveCount(3);
  for (const entry of fixture.commit.entries) {
    await expect(
      diffs.filter({ has: page.getByRole("heading", { name: entry.path }) }),
    ).toHaveCount(1);
  }
  await expect(page.locator('[data-diff-path="docs/one.md"] [data-line-type="add"]')).toBeVisible();
  await expect(page.locator('[data-diff-path="docs/two.md"] [data-line-type="add"]')).toBeVisible();
  await expect(
    page.locator('[data-diff-path="docs/three.md"] [data-line-type="add"]'),
  ).toBeVisible();
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("@smoke recent changes folds three adjacent entries from one commit", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const fixture = await installCommitFixture(page);

  await page.goto(`/s/${FIXTURE_STASH}`);
  const recent = page.getByRole("region", { name: "Recent changes" });
  const group = recent.locator(`[data-commit-id="${FIXTURE_COMMIT_ID}"]`);
  await expect(group).toBeVisible();
  await expect(group.locator("summary")).toHaveText(`3 changes in commit ${FIXTURE_COMMIT_ID}`);
  await expect(group.locator(".zhs-change-row")).toHaveCount(3);
  await expect(group.getByRole("link", { name: `Commit ${FIXTURE_COMMIT_ID}` })).toHaveCount(3);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("@smoke revert commit renders the per-path conflict banner", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const fixture = await installCommitFixture(page);

  await page.goto(`/s/${FIXTURE_STASH}/commits/${FIXTURE_COMMIT_ID}`);
  await page.getByRole("button", { name: "Revert commit" }).click();
  const dialog = page.getByRole("dialog", { name: "Revert commit" });
  await expect(dialog.getByRole("button", { name: "Revert commit" })).toBeEnabled();
  await dialog.getByRole("textbox", { name: "Author" }).fill("browser-reviewer");
  await dialog.getByRole("textbox", { name: "Message" }).fill("Attempt browser revert");
  await dialog.getByRole("button", { name: "Revert commit" }).click();

  await expect(
    dialog.getByText("The commit could not be reverted because heads changed.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("docs/one.md: expected v2, now v3", { exact: true })).toBeVisible();
  expect(fixture.revertRequests).toEqual([
    { author: "browser-reviewer", message: "Attempt browser revert", meta: {} },
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});
