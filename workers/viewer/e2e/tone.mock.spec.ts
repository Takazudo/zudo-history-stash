import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const versions = [
  {
    version: 2,
    kind: "put",
    hash: "sha256-v2",
    size: 12,
    rollbackOf: null,
    author: "Ada",
    message: "Current copy",
    meta: {},
    createdAt: "2026-08-25T09:00:00.000Z",
  },
  {
    version: 1,
    kind: "put",
    hash: "sha256-v1",
    size: 11,
    rollbackOf: null,
    author: "Grace",
    message: "Initial copy",
    meta: {},
    createdAt: "2026-08-25T08:00:00.000Z",
  },
];

const history = {
  path: "docs/readme.txt",
  headVersion: 2,
  deleted: false,
  total: 2,
  versions,
  nextBefore: null,
};

const file = {
  path: "docs/readme.txt",
  version: 2,
  hash: "sha256-v2",
  size: 12,
  kind: "put",
  author: "Ada",
  message: "Current copy",
  meta: {},
  createdAt: "2026-08-25T09:00:00.000Z",
  deleted: false,
  body: "Hello world\n",
};

const diff = {
  state: "same",
  unified: "",
  truncated: false,
  stats: { added: 0, removed: 0 },
  hunks: [],
  from: { version: 1, hash: "sha256-v1", deleted: false },
  to: { version: 2, hash: "sha256-v2", deleted: false },
};

async function mockViewerApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    let value: object;

    if (pathname === "/api/v1/me") {
      value = { principal: "admin" };
    } else if (pathname === "/api/v1/stashes") {
      value = {
        stashes: [
          {
            name: "notes",
            description: "Team notes",
            fileCount: 1,
            deletedFileCount: 0,
            lastChangeId: 2,
            lastChangeAt: "2026-08-25T09:00:00.000Z",
            createdAt: "2026-08-25T08:00:00.000Z",
          },
        ],
        nextAfter: null,
      };
    } else if (pathname === "/api/v1/changes") {
      value = { changes: [], hasMore: false, nextBefore: null };
    } else if (pathname === "/api/v1/stashes/notes/files") {
      value = {
        files: [
          {
            path: "docs/readme.txt",
            headVersion: 2,
            hash: "sha256-v2",
            size: 12,
            deleted: false,
            updatedAt: "2026-08-25T09:00:00.000Z",
          },
        ],
        nextAfter: null,
      };
    } else if (pathname === "/api/v1/stashes/notes/changes") {
      value = { changes: [], hasMore: false, nextBefore: null };
    } else if (pathname === "/api/v1/stashes/notes/files/docs/readme.txt") {
      value =
        url.searchParams.get("version") === "1"
          ? {
              ...file,
              version: 1,
              hash: "sha256-v1",
              size: 11,
              author: "Grace",
              message: "Initial copy",
              createdAt: "2026-08-25T08:00:00.000Z",
            }
          : file;
    } else if (pathname === "/api/v1/stashes/notes/history/docs/readme.txt") {
      value = history;
    } else if (pathname === "/api/v1/stashes/notes/diff/docs/readme.txt") {
      value = diff;
    } else {
      value = { error: { code: "not-found", message: "Not found" } };
    }

    await route.fulfill({ status: "error" in value ? 404 : 200, json: value });
  });
}

test("dark default, compact geometry, square shape, and persisted theme cycle", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => sessionStorage.setItem("zhs.token", "zhs_test"));
  await mockViewerApi(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stashes", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "notes" })).toBeVisible();

  const defaultTone = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const firstRow = document.querySelector(".table tbody tr")!;
    return {
      bodyBackground: style("body").backgroundColor,
      bodyColor: style("body").color,
      titleColor: style(".page__title").color,
      buttonHeight: document.querySelector(".button")!.getBoundingClientRect().height,
      buttonRadius: style(".button").borderRadius,
      badgeRadius: style(".badge").borderRadius,
      rowHeight: firstRow.getBoundingClientRect().height,
    };
  });
  expect(defaultTone).toEqual({
    bodyBackground: "rgb(28, 28, 28)",
    bodyColor: "rgb(184, 184, 184)",
    titleColor: "rgb(224, 224, 224)",
    buttonHeight: 28,
    buttonRadius: "0px",
    badgeRadius: "0px",
    rowHeight: 28,
  });

  const theme = page.locator(".app-header__actions").getByRole("button").first();
  await theme.hover();
  expect(await theme.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    "rgb(59, 54, 48)",
  );
  expect(await theme.evaluate((element) => getComputedStyle(element).color)).toBe(
    "rgb(224, 224, 224)",
  );
  await theme.click();
  await expect(theme).toHaveText("Theme: system");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(224, 224, 224)");
  await theme.click();
  await expect(theme).toHaveText("Theme: light");
  expect(await page.evaluate(() => localStorage.getItem("zhs.theme"))).toBe("light");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(224, 224, 224)");

  await page.reload();
  await expect(page.getByRole("button", { name: "Theme: light" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.getByRole("button", { name: "Theme: light" }).click();
  await expect(page.getByRole("button", { name: "Theme: dark" })).toBeVisible();

  await page.goto("/s/notes/f/docs/readme.txt");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await page.getByRole("button", { name: "Rollback to v1" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("0px");
  expect(
    await dialog.evaluate((element) => getComputedStyle(element, "::backdrop").backgroundColor),
  ).toBe("rgba(0, 0, 0, 0.6)");

  await page.getByRole("button", { name: "Close rollback dialog" }).click();
  await page.goto("/s/notes/f/docs/readme.txt?version=1");
  const activeRow = page.locator('[data-history-version="1"]');
  const inactiveRow = page.locator('[data-history-version="2"]');
  await expect(activeRow).toHaveAttribute("aria-current", "true");
  const activeStyle = await activeRow
    .locator("td")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        borderColor: style.borderInlineStartColor,
        borderWidth: style.borderInlineStartWidth,
        color: style.color,
      };
    });
  expect(activeStyle).toEqual({
    background: "rgb(56, 56, 56)",
    borderColor: "rgb(174, 133, 86)",
    borderWidth: "2px",
    color: "rgb(224, 224, 224)",
  });
  expect(
    await inactiveRow
      .locator("td")
      .first()
      .evaluate((element) => getComputedStyle(element).borderInlineStartWidth),
  ).toBe("2px");
});

test("every existing page renders under explicit dark and light themes", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("zhs.token", "zhs_test"));
  await mockViewerApi(page);

  const paths = [
    "/login",
    "/",
    "/s/notes",
    "/s/notes/f/docs/readme.txt",
    "/s/notes/diff/docs/readme.txt?from=1&to=head&context=3",
  ];

  for (const theme of ["dark", "light"] as const) {
    await page.goto("/login");
    await page.evaluate((value) => localStorage.setItem("zhs.theme", value), theme);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator(".page")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        theme === "dark" ? "rgb(28, 28, 28)" : "rgb(224, 224, 224)",
      );
    }
  }
});
