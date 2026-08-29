import type { Page, Request } from "@playwright/test";
import type { CapabilitiesResponse } from "@takazudo/zudo-history-stash";
import { expect, test } from "./fixtures/console-errors.js";

const STASH = "notes";
const PATH = "drafts/launch-note.md";
const BODY = "# Launch note\n\nReady for review.\n";
const FILE_ROUTE = `/api/v1/stashes/${STASH}/files/${PATH}`;
const HISTORY_ROUTE = `/api/v1/stashes/${STASH}/history/${PATH}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CAPABILITIES: CapabilitiesResponse = {
  representations: ["text", "binary"],
  contentAccess: ["inline", "raw", "deleted"],
  transferModes: ["json", "single", "multipart"],
  storageTiers: ["d1", "r2"],
  limits: {
    jsonInlineMaxBytes: 5_000_000,
    d1InlineMaxBytes: 524_288,
    httpRequestMaxBytes: 100_000_000,
    singleUploadMaxBytes: 33_554_432,
    maxFileBytes: 100_000_000,
    diffMaxBytesPerSide: 524_288,
    multipartPartBytes: 8_388_608,
    maxMultipartParts: 10_000,
    maxOpenUploadSessionsPerStash: 8,
    maxReservedUploadBytesPerStash: 500_000_000,
    uploadSessionTtlSeconds: 86_400,
  },
};

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
  const hash = await sha256Hex(BODY);
  const createdAt = "2026-08-25T12:00:00.000Z";
  const size = new TextEncoder().encode(BODY).byteLength;
  const mutationRequests: Array<{ body: unknown; idempotencyKey: string }> = [];
  const destinationReads: string[] = [];
  const unexpectedRequests: string[] = [];
  let created = false;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;

    if (request.method() === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/capabilities" &&
      url.search === ""
    ) {
      await route.fulfill({ status: 200, json: CAPABILITIES });
      return;
    }

    if (request.method() === "PUT" && url.pathname === FILE_ROUTE && url.search === "") {
      mutationRequests.push({
        body: jsonBody(request),
        idempotencyKey: request.headers()["idempotency-key"] ?? "",
      });
      if (mutationRequests.length === 1) {
        created = true;
        await route.fulfill({
          status: 201,
          json: { version: 1, hash, size, changeId: 51, createdAt },
        });
        return;
      }
    }

    if (
      created &&
      request.method() === "GET" &&
      url.pathname === FILE_ROUTE &&
      [...url.searchParams].length === 0
    ) {
      destinationReads.push(signature);
      await route.fulfill({
        status: 200,
        json: {
          path: PATH,
          version: 1,
          hash,
          size,
          kind: "put",
          author: "",
          message: "",
          meta: {},
          createdAt,
          deleted: false,
          body: BODY,
        },
      });
      return;
    }

    if (
      created &&
      request.method() === "GET" &&
      url.pathname === HISTORY_ROUTE &&
      ([...url.searchParams].length === 0 ||
        ([...url.searchParams].length === 1 && url.searchParams.has("limit")))
    ) {
      await route.fulfill({
        status: 200,
        json: {
          path: PATH,
          headVersion: 1,
          deleted: false,
          total: 1,
          versions: [
            {
              version: 1,
              kind: "put",
              hash,
              size,
              rollbackOf: null,
              author: "",
              message: "",
              meta: {},
              createdAt,
            },
          ],
          nextBefore: null,
        },
      });
      return;
    }

    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: `Unexpected mock request: ${signature}` } },
    });
  });

  return { destinationReads, mutationRequests, unexpectedRequests };
}

test("@smoke new file sends an explicit create fence and renders the destination", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fixture = await installFixture(page);

  await page.goto(`/s/${STASH}/new`);
  await expect(page.getByRole("heading", { name: "Create file" })).toBeVisible();
  await page.getByRole("textbox", { name: "Path", exact: true }).fill(PATH);
  await page.getByRole("textbox", { name: "File body" }).fill(BODY);
  await page.getByRole("button", { name: "Create file" }).click();

  await expect(page).toHaveURL((url) => url.pathname === `/s/${STASH}/f/${PATH}`);
  await expect(page.getByRole("heading", { name: PATH, level: 1 })).toBeVisible();
  await expect(page.locator(".file-body-pane")).toHaveText(BODY.trim());
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("1 version, newest first.");
  await expect(history.locator('[data-history-version="1"]')).toContainText("put");

  expect(fixture.mutationRequests).toEqual([
    {
      body: { body: BODY, expectedVersion: null },
      idempotencyKey: expect.stringMatching(UUID),
    },
  ]);
  expect(fixture.destinationReads).toHaveLength(1);
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
