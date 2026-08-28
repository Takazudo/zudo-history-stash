import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { expect, test } from "./fixtures/console-errors.js";
import { fulfillEmptyOpenProposalCount } from "./fixtures/proposal-count.js";

const LARGE_FILE_BYTES = 1_500_000;
const LARGE_FILE_PATH = "fixtures/r2-large.txt";
const LARGE_FILE_PREFIX = "History Stash R2 large-file fixture\n";
const LARGE_FILE_SUFFIX = "\nHistory Stash R2 large-file fixture end\n";
const LARGE_FILE_LINE = `${"x".repeat(4_095)}\n`;

interface WidthSnapshot {
  bodyContained: boolean;
  documentContained: boolean;
  pageScrollContained: boolean;
  paneInsideViewport: boolean;
  paneOwnsHorizontalOverflow: boolean;
}

function largeFileBody(): string {
  const fillBytes = LARGE_FILE_BYTES - LARGE_FILE_PREFIX.length - LARGE_FILE_SUFFIX.length;
  const body = `${LARGE_FILE_PREFIX}${LARGE_FILE_LINE.repeat(
    Math.floor(fillBytes / LARGE_FILE_LINE.length),
  )}${"x".repeat(fillBytes % LARGE_FILE_LINE.length)}${LARGE_FILE_SUFFIX}`;
  if (body.length !== LARGE_FILE_BYTES) throw new Error("Large-file fixture size drifted");
  return body;
}

function widthSnapshot(): WidthSnapshot {
  const pageScroll = document.querySelector<HTMLElement>(".page__scroll");
  const pane = document.querySelector<HTMLElement>(".file-body-pane");
  if (pageScroll === null || pane === null) {
    throw new Error("The large-file overflow surface is incomplete");
  }
  const paneRect = pane.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  return {
    documentContained: document.documentElement.scrollWidth <= viewportWidth,
    bodyContained: document.body.scrollWidth <= document.body.clientWidth,
    pageScrollContained: pageScroll.scrollWidth <= pageScroll.clientWidth,
    paneInsideViewport: paneRect.left >= -1 && paneRect.right <= viewportWidth + 1,
    paneOwnsHorizontalOverflow: pane.scrollWidth > pane.clientWidth,
  };
}

test("@smoke 1.5 MB file keeps long-line overflow inside the body pane", async ({ page }) => {
  const body = largeFileBody();
  const largeHash = await sha256Hex(body);
  const smallBody = "small predecessor\n";
  const smallHash = await sha256Hex(smallBody);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.addInitScript(() => sessionStorage.setItem("zhs.token", "zhs_test"));
  await page.route("**/api/v1/**", async (route) => {
    if (await fulfillEmptyOpenProposalCount(route, [{ stash: "demo", path: LARGE_FILE_PATH }]))
      return;
    const url = new URL(route.request().url());
    let value: object;
    if (url.pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (url.pathname === `/api/v1/stashes/demo/files/${LARGE_FILE_PATH}`) {
      value = {
        path: LARGE_FILE_PATH,
        version: 2,
        hash: largeHash,
        size: LARGE_FILE_BYTES,
        kind: "put",
        author: "seed-dev",
        message: "Seed deterministic 1.5 MB R2 fixture",
        meta: { fixture: "seed-dev-large" },
        createdAt: "2026-08-27T04:00:00.000Z",
        deleted: false,
        body,
      };
    } else if (url.pathname === `/api/v1/stashes/demo/history/${LARGE_FILE_PATH}`) {
      value = {
        path: LARGE_FILE_PATH,
        headVersion: 2,
        deleted: false,
        total: 2,
        versions: [
          {
            version: 2,
            kind: "put",
            hash: largeHash,
            size: LARGE_FILE_BYTES,
            rollbackOf: null,
            author: "seed-dev",
            message: "Seed deterministic 1.5 MB R2 fixture",
            meta: { fixture: "seed-dev-large" },
            createdAt: "2026-08-27T04:00:00.000Z",
          },
          {
            version: 1,
            kind: "put",
            hash: smallHash,
            size: smallBody.length,
            rollbackOf: null,
            author: "seed-dev",
            message: "Small predecessor",
            meta: {},
            createdAt: "2026-08-27T03:00:00.000Z",
          },
        ],
        nextBefore: null,
      };
    } else if (url.pathname === `/api/v1/stashes/demo/diff/${LARGE_FILE_PATH}`) {
      value = {
        state: "oversized",
        reason: "bytes",
        from: { version: 1, hash: smallHash, deleted: false },
        to: { version: 2, hash: largeHash, deleted: false },
      };
    } else {
      value = { error: { code: "not-found", message: "Not found" } };
    }
    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });

  await page.goto(`/s/demo/f/${LARGE_FILE_PATH}`);
  const pane = page.locator(".file-body-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute("data-wrap-long-lines", "false");
  const bodySnapshot = await pane.evaluate(
    async (element, markers) => {
      const text = element.textContent ?? "";
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        byteLength: bytes.byteLength,
        hash: `sha256-${hex}`,
        prefix: text.startsWith(markers.prefix),
        suffix: text.endsWith(markers.suffix),
      };
    },
    { prefix: LARGE_FILE_PREFIX, suffix: LARGE_FILE_SUFFIX },
  );
  expect(bodySnapshot).toEqual({
    byteLength: LARGE_FILE_BYTES,
    hash: largeHash,
    prefix: true,
    suffix: true,
  });

  // Expected: the document, body, and page scroller stay viewport-contained.
  // Forbidden: the unbroken fixture line widens the page instead of the local pre scroller.
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() => page.evaluate(widthSnapshot))
      .toEqual({
        documentContained: true,
        bodyContained: true,
        pageScrollContained: true,
        paneInsideViewport: true,
        paneOwnsHorizontalOverflow: true,
      });
  }

  await page.goto(`/s/demo/diff/${LARGE_FILE_PATH}?from=1&to=head`);
  const oversized = page
    .getByRole("status")
    .filter({ hasText: "Diff unavailable for this comparison" });
  await expect(oversized).toContainText("512 KiB per-side diff limit");
  await expect(oversized.getByRole("link", { name: "Open v1 raw" })).toHaveAttribute(
    "href",
    `/s/demo/f/${LARGE_FILE_PATH}?version=1`,
  );
  await expect(oversized.getByRole("link", { name: "Open v2 raw" })).toHaveAttribute(
    "href",
    `/s/demo/f/${LARGE_FILE_PATH}?version=2`,
  );
});
