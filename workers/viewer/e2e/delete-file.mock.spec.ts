import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const STASH = "notes";
const PATH = "docs/retired.md";
const BODY = "This document will be retired.\n";
const FILE_ROUTE = `/api/v1/stashes/${STASH}/files/${PATH}`;
const HISTORY_ROUTE = `/api/v1/stashes/${STASH}/history/${PATH}`;
const DIFF_ROUTE = `/api/v1/stashes/${STASH}/diff/${PATH}`;
const DELETE_ROUTE = `/api/v1/stashes/${STASH}/delete/${PATH}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

function jsonBody(request: Request): unknown {
  const body = request.postData();
  return body === null ? null : (JSON.parse(body) as unknown);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256-${hex}`;
}

async function installFixture(page: Page) {
  const liveHash = await sha256Hex(BODY);
  const firstHash = await sha256Hex("Initial copy.\n");
  const deletedAt = "2026-08-25T12:30:00.000Z";
  const liveSize = new TextEncoder().encode(BODY).byteLength;
  const mutationRequests: Array<{ body: unknown; uuid: string }> = [];
  const tombstoneReads: string[] = [];
  const historyStates: boolean[] = [];
  const unexpectedRequests: string[] = [];
  let deleted = false;

  const liveFile = {
    path: PATH,
    version: 2,
    hash: liveHash,
    size: liveSize,
    kind: "put",
    author: "Ada",
    message: "Approved copy",
    meta: {},
    createdAt: "2026-08-25T11:00:00.000Z",
    deleted: false,
    body: BODY,
  };
  const tombstone = {
    path: PATH,
    version: 3,
    hash: null,
    size: 0,
    kind: "delete",
    author: "",
    message: "",
    meta: {},
    createdAt: deletedAt,
    deleted: true,
    body: null,
  };
  const liveHistory = [
    {
      version: 2,
      kind: "put",
      hash: liveHash,
      size: liveSize,
      rollbackOf: null,
      author: "Ada",
      message: "Approved copy",
      meta: {},
      createdAt: "2026-08-25T11:00:00.000Z",
    },
    {
      version: 1,
      kind: "put",
      hash: firstHash,
      size: 14,
      rollbackOf: null,
      author: "Grace",
      message: "Initial copy",
      meta: {},
      createdAt: "2026-08-25T10:00:00.000Z",
    },
  ];
  const deletedHistory = [
    {
      version: 3,
      kind: "delete",
      hash: null,
      size: 0,
      rollbackOf: null,
      author: "",
      message: "",
      meta: {},
      createdAt: deletedAt,
    },
    ...liveHistory,
  ];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;


    if (request.method() === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (request.method() === "POST" && url.pathname === DELETE_ROUTE && url.search === "") {
      mutationRequests.push({
        body: jsonBody(request),
        uuid: request.headers()["idempotency-key"] ?? "",
      });
      if (mutationRequests.length === 1) {
        deleted = true;
        await route.fulfill({
          status: 200,
          json: { version: 3, changeId: 61, createdAt: deletedAt },
        });
        return;
      }
    }

    if (request.method() === "GET" && url.pathname === FILE_ROUTE) {
      const requestedVersion = url.searchParams.get("version");
      if (requestedVersion === null && [...url.searchParams].length === 0) {
        if (!deleted) {
          await route.fulfill({ status: 200, json: liveFile });
          return;
        }
        tombstoneReads.push(signature);
        await route.fulfill({
          status: 404,
          json: {
            error: { code: "file-deleted", message: "The file head is a tombstone." },
            current: {
              version: 3,
              hash: null,
              deleted: true,
              kind: "delete",
              author: "",
              createdAt: deletedAt,
            },
          },
        });
        return;
      }
      if (deleted && requestedVersion === "3" && url.searchParams.size === 1) {
        tombstoneReads.push(signature);
        await route.fulfill({ status: 200, json: tombstone });
        return;
      }
    }

    if (request.method() === "GET" && url.pathname === HISTORY_ROUTE) {
      const allowedQuery =
        [...url.searchParams].length === 0 ||
        ([...url.searchParams].length === 1 && url.searchParams.has("limit"));
      if (allowedQuery) {
        historyStates.push(deleted);
        const versions = deleted ? deletedHistory : liveHistory;
        await route.fulfill({
          status: 200,
          json: {
            path: PATH,
            headVersion: deleted ? 3 : 2,
            deleted,
            total: versions.length,
            versions,
            nextBefore: null,
          },
        });
        return;
      }
    }

    if (request.method() === "GET" && url.pathname === DIFF_ROUTE) {
      const from = Number.parseInt(url.searchParams.get("from") ?? "", 10);
      const to = Number.parseInt(url.searchParams.get("to") ?? "", 10);
      if (
        Number.isSafeInteger(from) &&
        from > 0 &&
        Number.isSafeInteger(to) &&
        to > 0 &&
        [...url.searchParams].every(([key]) => key === "from" || key === "to")
      ) {
        await route.fulfill({
          status: 200,
          json: {
            state: "same",
            unified: "",
            truncated: false,
            stats: { added: 0, removed: 0 },
            hunks: [],
            from: { version: from, hash: from === 1 ? firstHash : liveHash, deleted: false },
            to: {
              version: to,
              hash: to === 3 ? null : liveHash,
              deleted: to === 3,
            },
          },
        });
        return;
      }
    }

    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: `Unexpected mock request: ${signature}` } },
    });
  });

  return { historyStates, mutationRequests, tombstoneReads, unexpectedRequests };
}

test.use({
  allowedConsoleErrors: [
    {
      pattern:
        /^Failed to load resource: the server responded with a status of 404(?: \(Not Found\))?$/u,
      why: "The file page deliberately follows the typed file-deleted response to its tombstone.",
    },
  ],
});

test("@smoke delete appends a tombstone and renders deleted history", async ({ page }) => {
  await page.addInitScript(tokenScript);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fixture = await installFixture(page);

  await page.goto(`/s/${STASH}/f/${PATH}`);
  await expect(page.locator(".file-body-pane")).toHaveText(BODY.trim());
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${PATH}` });
  await expect(dialog.getByText(/Creates v3 as a tombstone/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Delete as v3" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".file-tombstone-state")).toContainText(
    "Deleted at v3 by unknown author.",
  );
  await expect(page.getByText("Tombstone representation.", { exact: true })).toBeVisible();
  await expect(
    page.getByText("This version is a tombstone; it has no body.", { exact: true }),
  ).toBeVisible();
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("3 versions, newest first.");
  const deletedRow = history.locator('[data-history-version="3"]');
  await expect(deletedRow).toContainText("delete");
  await expect(deletedRow).toContainText("deleted");
  await expect(deletedRow).toHaveAttribute("aria-current", "true");

  expect(fixture.mutationRequests).toEqual([
    { body: { expectedVersion: 2 }, uuid: expect.stringMatching(UUID) },
  ]);
  expect(fixture.tombstoneReads).toEqual([`GET ${FILE_ROUTE}`, `GET ${FILE_ROUTE}?version=3`]);
  expect(fixture.historyStates).toContain(false);
  expect(fixture.historyStates).toContain(true);
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
