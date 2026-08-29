import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";
import {
  FIXTURE_CHANGE_SET_ID,
  FIXTURE_COMMIT_ID,
  FIXTURE_STASH,
  changeSetDiff,
  changeSetRecord,
  commitDiff,
  commitRecord,
} from "./fixtures/history-fixtures.js";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_e2e_admin");

function jsonBody(request: Request): unknown {
  const body = request.postData();
  return body === null ? null : (JSON.parse(body) as unknown);
}

async function installChangeSetFixture(page: Page, mode: "approve" | "reject" | "applied") {
  const open = changeSetRecord({
    entries: [
      {
        path: "docs/one.md",
        op: "put",
        baseVersion: null,
        current: null,
        stale: false,
      },
    ],
  });
  const approvedCommit = commitRecord({
    id: FIXTURE_COMMIT_ID,
    source: "change-set",
    sourceId: FIXTURE_CHANGE_SET_ID,
    message: "Approved review",
    firstChangeId: 201,
    lastChangeId: 201,
    entries: [
      {
        path: "docs/one.md",
        op: "put",
        version: 1,
        kind: "put",
        changeId: 201,
        hash: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        size: 24,
        contentType: "text/markdown",
        representation: "text",
        rollbackOf: null,
      },
    ],
  });
  const applied = changeSetRecord({
    ...open,
    status: "applied",
    decidedAt: "2026-08-25T10:05:00.000Z",
    decidedBy: "admin",
    decisionReason: null,
    commitId: approvedCommit.id,
  });
  const rejected = changeSetRecord({
    ...open,
    status: "rejected",
    decidedAt: "2026-08-25T10:06:00.000Z",
    decidedBy: "admin",
    decisionReason: "Not ready for release",
    commitId: null,
  });
  let current = mode === "applied" ? applied : open;
  const decisionRequests: unknown[] = [];
  const unexpectedRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const signature = `${method} ${url.pathname}${url.search}`;

    if (method === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({
        status: 200,
        json:
          mode === "applied"
            ? {
                principal: "stash",
                stash: FIXTURE_STASH,
                tokenId: "tok_e2e_read",
                scope: "read",
                expiresAt: null,
              }
            : { principal: "admin" },
      });
      return;
    }

    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}`
    ) {
      await route.fulfill({ status: 200, json: current });
      return;
    }

    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}/diff`
    ) {
      await route.fulfill({
        status: 200,
        json: changeSetDiff(current, { status: current.status }),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname ===
        `/api/v1/stashes/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}/approve`
    ) {
      decisionRequests.push({ kind: "approve", body: jsonBody(request) });
      current = applied;
      await route.fulfill({ status: 200, json: { status: "applied", commit: approvedCommit } });
      return;
    }

    if (
      method === "POST" &&
      url.pathname ===
        `/api/v1/stashes/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}/reject`
    ) {
      decisionRequests.push({ kind: "reject", body: jsonBody(request) });
      current = rejected;
      await route.fulfill({ status: 200, json: rejected });
      return;
    }

    if (
      mode === "approve" &&
      method === "GET" &&
      url.pathname.endsWith(`/commits/${FIXTURE_COMMIT_ID}`)
    ) {
      await route.fulfill({ status: 200, json: approvedCommit });
      return;
    }

    if (
      mode === "approve" &&
      method === "GET" &&
      url.pathname.endsWith(`/commits/${FIXTURE_COMMIT_ID}/diff`)
    ) {
      await route.fulfill({ status: 200, json: commitDiff(approvedCommit) });
      return;
    }

    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 404,
      json: { error: { code: "not-found", message: `Unexpected mock request: ${signature}` } },
    });
  });

  return { approvedCommit, decisionRequests, open, rejected, unexpectedRequests };
}

test("@smoke change-set approve captures the request and lands on its commit page", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const fixture = await installChangeSetFixture(page, "approve");

  await page.goto(`/s/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}`);
  await expect(page.getByRole("heading", { name: fixture.open.message })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Approve change set" });
  await dialog.getByRole("textbox", { name: "Author" }).fill("browser-reviewer");
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("Approve from browser");
  await dialog.getByRole("button", { name: "Approve and apply" }).click();

  await expect(page).toHaveURL(`/s/${FIXTURE_STASH}/commits/${fixture.approvedCommit.id}`);
  await expect(page.getByRole("heading", { name: "Approved review" })).toBeVisible();
  expect(fixture.decisionRequests).toEqual([
    {
      kind: "approve",
      body: { author: "browser-reviewer", message: "Approve from browser" },
    },
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("@smoke change-set reject captures the reason and renders its decision record", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const fixture = await installChangeSetFixture(page, "reject");

  await page.goto(`/s/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}`);
  await page.getByRole("button", { name: "Reject" }).click();
  const dialog = page.getByRole("dialog", { name: "Reject change set" });
  await dialog.getByRole("textbox", { name: "Reason (optional)" }).fill("Not ready for release");
  await dialog.getByRole("button", { name: "Reject" }).click();

  await expect(page.getByText("Decision: rejected", { exact: true })).toBeVisible();
  await expect(
    page.getByText("By admin at 2026-08-25T10:06:00.000Z", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not ready for release", { exact: true })).toBeVisible();
  expect(fixture.decisionRequests).toEqual([
    { kind: "reject", body: { reason: "Not ready for release" } },
  ]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("@smoke applied change-set renders its authoritative decision record for read access", async ({
  page,
}) => {
  await page.addInitScript(() => sessionStorage.setItem("zhs.token", "zhs_e2e_read"));
  const fixture = await installChangeSetFixture(page, "applied");

  await page.goto(`/s/${FIXTURE_STASH}/change-sets/${FIXTURE_CHANGE_SET_ID}`);
  await expect(page.getByText("Decision: applied", { exact: true })).toBeVisible();
  await expect(
    page.getByText("By admin at 2026-08-25T10:05:00.000Z", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: fixture.approvedCommit.id })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("@smoke stash navigation shows the authoritative open change-set count", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const unexpectedRequests: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const signature = `${method} ${url.pathname}${url.search}`;
    if (method === "GET" && url.pathname === "/api/v1/me") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }
    if (method === "GET" && url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/files`) {
      await route.fulfill({ status: 200, json: { files: [], nextAfter: null } });
      return;
    }
    if (method === "GET" && url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/changes`) {
      await route.fulfill({ status: 200, json: { changes: [], hasMore: false, nextBefore: null } });
      return;
    }
    if (
      method === "GET" &&
      url.pathname === `/api/v1/stashes/${FIXTURE_STASH}/change-sets` &&
      url.searchParams.get("status") === "open" &&
      url.searchParams.get("limit") === "1"
    ) {
      await route.fulfill({
        status: 200,
        json: { changeSets: [changeSetRecord()], nextAfter: null, total: 7 },
      });
      return;
    }
    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 404,
      json: { error: { code: "not-found", message: `Unexpected mock request: ${signature}` } },
    });
  });

  await page.goto(`/s/${FIXTURE_STASH}`);
  await expect(page.getByRole("link", { name: "Change sets (7 open)" })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});
