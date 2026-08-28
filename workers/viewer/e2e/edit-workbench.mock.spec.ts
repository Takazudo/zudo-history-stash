import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";
import { fulfillEmptyOpenProposalCount } from "./fixtures/proposal-count.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const FILE_ROUTE = `/api/v1/stashes/${STASH}/files/${PATH}`;
const HISTORY_ROUTE = `/api/v1/stashes/${STASH}/history/${PATH}`;
const DIFF_ROUTE = `/api/v1/stashes/${STASH}/diff/${PATH}`;
const INITIAL_BODY = "alpha\nhead\n";
const REMOTE_BODY = "alpha\nremote head\n";
const DRAFT_BODY = "alpha\nlocal draft\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

interface PutCapture {
  body: unknown;
  idempotencyKey: string;
}

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

function versionRecord({
  version,
  hash,
  body,
  author,
  message,
  createdAt,
}: {
  version: number;
  hash: string;
  body: string;
  author: string;
  message: string;
  createdAt: string;
}) {
  return {
    version,
    kind: "put",
    hash,
    size: new TextEncoder().encode(body).byteLength,
    rollbackOf: null,
    author,
    message,
    meta: {},
    createdAt,
  };
}

function fileRecord({
  version,
  hash,
  body,
  author,
  message,
  createdAt,
}: {
  version: number;
  hash: string;
  body: string;
  author: string;
  message: string;
  createdAt: string;
}) {
  return {
    path: PATH,
    version,
    hash,
    size: new TextEncoder().encode(body).byteLength,
    kind: "put",
    author,
    message,
    meta: {},
    createdAt,
    deleted: false,
    body,
  };
}

async function installFixture(page: Page) {
  const initialHash = await sha256Hex(INITIAL_BODY);
  const remoteHash = await sha256Hex(REMOTE_BODY);
  const savedHash = await sha256Hex(DRAFT_BODY);
  const initial = fileRecord({
    version: 2,
    hash: initialHash,
    body: INITIAL_BODY,
    author: "Ada",
    message: "Current head",
    createdAt: "2026-08-25T09:00:00.000Z",
  });
  const remote = fileRecord({
    version: 3,
    hash: remoteHash,
    body: REMOTE_BODY,
    author: "Remote",
    message: "Remote head message",
    createdAt: "2026-08-25T10:00:00.000Z",
  });
  const saved = fileRecord({
    version: 4,
    hash: savedHash,
    body: DRAFT_BODY,
    author: "Local author",
    message: "Typed local message",
    createdAt: "2026-08-25T11:00:00.000Z",
  });
  const old = versionRecord({
    version: 1,
    hash: await sha256Hex("alpha\nfirst\n"),
    body: "alpha\nfirst\n",
    author: "Grace",
    message: "Initial copy",
    createdAt: "2026-08-25T08:00:00.000Z",
  });
  const initialVersion = versionRecord(initial);
  const remoteVersion = versionRecord(remote);
  const savedVersion = versionRecord(saved);
  const putRequests: PutCapture[] = [];
  const savedVersionGets: string[] = [];
  const historyStates: string[] = [];
  const unexpectedRequests: string[] = [];
  let state: "initial" | "stale" | "saved" = "initial";

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;

    if (await fulfillEmptyOpenProposalCount(route, [{ stash: STASH, path: PATH }])) return;

    if (request.method() === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (url.pathname === FILE_ROUTE && request.method() === "PUT" && url.search === "") {
      putRequests.push({
        body: jsonBody(request),
        idempotencyKey: request.headers()["idempotency-key"] ?? "",
      });
      if (putRequests.length === 1) {
        state = "stale";
        await route.fulfill({
          status: 409,
          json: {
            error: { code: "stale", message: "Head changed." },
            current: {
              version: remote.version,
              hash: remote.hash,
              deleted: false,
              kind: "put",
              author: remote.author,
              createdAt: remote.createdAt,
            },
          },
        });
        return;
      }
      if (putRequests.length === 2) {
        state = "saved";
        await route.fulfill({
          status: 201,
          json: {
            version: saved.version,
            hash: saved.hash,
            size: saved.size,
            changeId: 44,
            createdAt: saved.createdAt,
          },
        });
        return;
      }
    }

    if (url.pathname === FILE_ROUTE && request.method() === "GET") {
      const requestedVersion = url.searchParams.get("version");
      if (requestedVersion === null && [...url.searchParams].length === 0) {
        await route.fulfill({
          status: 200,
          json: state === "initial" ? initial : state === "stale" ? remote : saved,
        });
        return;
      }
      if (requestedVersion === "4" && url.searchParams.size === 1 && state === "saved") {
        savedVersionGets.push(signature);
        await route.fulfill({ status: 200, json: saved });
        return;
      }
    }

    if (url.pathname === HISTORY_ROUTE && request.method() === "GET") {
      const allowedQuery =
        [...url.searchParams].length === 0 ||
        ([...url.searchParams].length === 1 && url.searchParams.has("limit"));
      if (allowedQuery) {
        historyStates.push(state);
        const versions =
          state === "saved"
            ? [savedVersion, remoteVersion, initialVersion, old]
            : [initialVersion, old];
        await route.fulfill({
          status: 200,
          json: {
            path: PATH,
            headVersion: state === "saved" ? 4 : 2,
            deleted: false,
            total: versions.length,
            versions,
            nextBefore: null,
          },
        });
        return;
      }
    }

    if (url.pathname === DIFF_ROUTE && request.method() === "GET") {
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
            from: { version: from, hash: initialHash, deleted: false },
            to: { version: to, hash: savedHash, deleted: false },
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

  return { historyStates, putRequests, savedVersionGets, unexpectedRequests };
}

test.use({
  allowedConsoleErrors: [
    {
      pattern:
        /^Failed to load resource: the server responded with a status of 409(?: \(Conflict\))?$/u,
      why: "The first routed save deliberately returns the expected CAS conflict.",
    },
  ],
});

test("@smoke edit workbench preserves its draft and saves after an explicit stale reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(tokenScript);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fixture = await installFixture(page);

  await page.goto(`/s/${STASH}/edit/${PATH}`);
  const editor = page.getByRole("textbox", { name: "Draft body" });
  await expect(editor).toHaveValue(INITIAL_BODY);
  await expect(page.getByRole("complementary", { name: "Version history" })).toBeVisible();

  await editor.fill(DRAFT_BODY);
  await expect(page.locator("del.zhs-diff-mark--removed").first()).toBeVisible();
  await expect(page.locator("ins.zhs-diff-mark--added").first()).toBeVisible();
  await expect(page.locator(".zhs-edit-workbench__stats-add")).toHaveText("+1");
  await expect(page.locator(".zhs-edit-workbench__stats-remove")).toHaveText("−1");

  const workbenchBody = page.locator(".zhs-edit-workbench__body");
  await expect(workbenchBody).toHaveAttribute("data-rail", "open");
  await page.getByRole("button", { name: "Collapse version history" }).click();
  await expect(workbenchBody).toHaveAttribute("data-rail", "closed");
  await expect(page.getByRole("button", { name: "Expand version history" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.getByRole("button", { name: "Expand version history" }).click();
  await expect(workbenchBody).toHaveAttribute("data-rail", "open");

  for (const width of [768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const tabs = page.getByRole("group", { name: "Pane" });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("button", { name: "Editor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('section[aria-label="Editor"]')).toBeVisible();
    await expect(page.locator('section[aria-label="Live candidate diff"]')).toBeHidden();
    await tabs.getByRole("button", { name: "Diff" }).click();
    await expect(page.locator('section[aria-label="Editor"]')).toBeHidden();
    await expect(page.locator('section[aria-label="Live candidate diff"]')).toBeVisible();
    await tabs.getByRole("button", { name: "Editor" }).click();
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("group", { name: "Pane" })).toHaveCount(0);
  await expect(page.locator('section[aria-label="Editor"]')).toBeVisible();
  await expect(page.locator('section[aria-label="Live candidate diff"]')).toBeVisible();

  await page.getByRole("button", { name: "Save…" }).click();
  let dialog = page.getByRole("dialog", { name: "Review save against head v2" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("table", { name: "Unified diff" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toHaveValue(DRAFT_BODY);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = sessionStorage.getItem("zhs.draft.notes.docs/readme.txt");
        if (stored === null) return null;
        const record: unknown = JSON.parse(stored);
        if (typeof record !== "object" || record === null || !("text" in record)) return null;
        return typeof record.text === "string" ? record.text : null;
      }),
    )
    .toBe(DRAFT_BODY);

  await page.getByRole("button", { name: "Save…" }).click();
  dialog = page.getByRole("dialog", { name: "Review save against head v2" });
  await dialog.getByRole("textbox", { name: "Message" }).fill("Typed local message");
  await dialog.getByRole("textbox", { name: "Author" }).fill("Local author");
  await dialog.getByRole("button", { name: "Save v3" }).click();

  await expect(dialog.getByText("Head moved to v3 by Remote", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Remote head message", { exact: true })).toHaveCount(0);
  expect(fixture.putRequests).toHaveLength(1);

  await dialog.getByRole("button", { name: "Reload & compare" }).click();
  dialog = page.getByRole("dialog", { name: "Review save against head v3" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Review save against head v3" })).toBeVisible();
  await expect(dialog.getByText("Remote head message", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Message" })).toHaveValue("Typed local message");
  await expect(dialog.getByRole("textbox", { name: "Author" })).toHaveValue("Local author");
  await expect(editor).toHaveValue(DRAFT_BODY);

  await dialog.getByRole("button", { name: "Save v4 on top of v3" }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/s/${STASH}/f/${PATH}`);
  await expect(page.getByRole("status", { name: "Save confirmation" })).toContainText("Saved v4.");
  await expect(page.locator(".file-body-pane")).toHaveText(DRAFT_BODY.trim());
  await expect(
    page.getByRole("region", { name: "History" }).locator('[data-history-version="4"]'),
  ).toContainText("Typed local message");

  expect(fixture.putRequests.map(({ body }) => body)).toEqual([
    {
      body: DRAFT_BODY,
      expectedVersion: 2,
      author: "Local author",
      message: "Typed local message",
    },
    {
      body: DRAFT_BODY,
      expectedVersion: 3,
      author: "Local author",
      message: "Typed local message",
    },
  ]);
  expect(fixture.putRequests[0]?.idempotencyKey).toMatch(UUID);
  expect(fixture.putRequests[1]?.idempotencyKey).toMatch(UUID);
  expect(fixture.putRequests[1]?.idempotencyKey).not.toBe(fixture.putRequests[0]?.idempotencyKey);
  expect(fixture.savedVersionGets).toHaveLength(1);
  expect(fixture.historyStates.filter((value) => value === "saved").length).toBeGreaterThanOrEqual(
    2,
  );
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
