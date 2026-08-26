import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const STASH = "notes";
const TOKENS_ROUTE = `/api/v1/stashes/${STASH}/tokens`;
const TOKEN_ID = "tok_e2e_confirm";
const TOKEN_SECRET = "zhs_one_time_secret_e2e_confirm";
const CREATED_AT = "2026-08-25T13:00:00.000Z";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_admin");

function jsonBody(request: Request): unknown {
  const body = request.postData();
  return body === null ? null : (JSON.parse(body) as unknown);
}

async function installFixture(page: Page) {
  const mintRequests: unknown[] = [];
  const listResponses: object[] = [];
  const requestOrder: string[] = [];
  const unexpectedRequests: string[] = [];
  let listCount = 0;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;

    if (request.method() === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (url.pathname === TOKENS_ROUTE && url.search === "" && request.method() === "GET") {
      listCount += 1;
      requestOrder.push("GET");
      if (listCount <= 2) {
        const value =
          listCount === 1
            ? { tokens: [] }
            : {
                tokens: [
                  {
                    id: TOKEN_ID,
                    label: "deploy operator",
                    scope: "write",
                    createdAt: CREATED_AT,
                    revokedAt: null,
                    lastUsedAt: null,
                  },
                ],
              };
        listResponses.push(value);
        await route.fulfill({ status: 200, json: value });
        return;
      }
    }

    if (url.pathname === TOKENS_ROUTE && url.search === "" && request.method() === "POST") {
      mintRequests.push(jsonBody(request));
      requestOrder.push("POST");
      if (mintRequests.length === 1 && listCount === 1) {
        await route.fulfill({
          status: 201,
          json: {
            id: TOKEN_ID,
            token: TOKEN_SECRET,
            label: "deploy operator",
            scope: "write",
            createdAt: CREATED_AT,
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

  return { listResponses, mintRequests, requestOrder, unexpectedRequests };
}

test("@smoke admin token mint reveals the secret once and refreshes metadata without it", async ({
  page,
}) => {
  await page.addInitScript(tokenScript);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const fixture = await installFixture(page);

  await page.goto(`/s/${STASH}/tokens`);
  await expect(
    page.getByText("No tokens have been minted for this stash.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Label (optional)" }).fill("deploy operator");
  await page.getByRole("combobox", { name: "Scope" }).selectOption("write");
  await expect(page.getByText(/Write tokens can modify this stash/u)).toBeVisible();
  await page.getByRole("button", { name: "Mint token" }).click();

  const secret = page.getByRole("textbox", { name: "New token secret" });
  await expect(secret).toHaveCount(1);
  await expect(secret).toHaveValue(TOKEN_SECRET);
  await expect(page.getByText("Shown once — store it now", { exact: true })).toBeVisible();

  const table = page.getByRole("table", { name: `Tokens for ${STASH}` });
  const row = table.locator(`[data-token-id="${TOKEN_ID}"]`);
  await expect(row).toContainText("deploy operator");
  await expect(row).toContainText("write");
  await expect(row).toContainText("Never");
  await expect(row).toContainText("Active");
  await expect(table).not.toContainText(TOKEN_SECRET);

  expect(fixture.mintRequests).toEqual([{ label: "deploy operator", scope: "write" }]);
  expect(fixture.requestOrder).toEqual(["GET", "POST", "GET"]);
  expect(fixture.listResponses).toHaveLength(2);
  expect(fixture.listResponses[1]).toEqual({
    tokens: [
      {
        id: TOKEN_ID,
        label: "deploy operator",
        scope: "write",
        createdAt: CREATED_AT,
        revokedAt: null,
        lastUsedAt: null,
      },
    ],
  });
  expect(JSON.stringify(fixture.listResponses[1])).not.toContain(TOKEN_SECRET);

  await page.getByRole("button", { name: "I stored it" }).click();
  await expect(page.getByRole("textbox", { name: "New token secret" })).toHaveCount(0);
  expect(await page.content()).not.toContain(TOKEN_SECRET);
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
