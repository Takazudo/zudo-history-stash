import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const ADMIN_TOKEN = process.env.STASH_ADMIN_TOKEN ?? "dev-admin-token";
const ADMIN_AUTHORIZATION = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const GUIDE_PATH = "docs/guide.md";

interface HistoryResponse {
  total: number;
  headVersion: number;
  versions: Array<{
    version: number;
    kind: string;
    rollbackOf: number | null;
    message?: string;
  }>;
}

interface MintedToken {
  id: string;
  token: string;
  label: string;
  scope: "write";
  createdAt: string;
  expiresAt: string | null;
  rotatedFrom: string | null;
}

interface MutationResult {
  version: number;
  changeId: number;
  createdAt: string;
}

interface LiveResources {
  path: string;
  tokenLabel: string;
  tokenId: string | null;
  tokenSecret: string | null;
}

interface ListedToken {
  id: string;
  label: string;
  revokedAt: string | null;
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function idempotencyKey(kind: string): string {
  return `viewer-live-${kind}-${globalThis.crypto.randomUUID()}`;
}

function liveFileUrl(path: string): string {
  return `/api/v1/stashes/demo/files/${path}`;
}

function liveHistoryUrl(path: string): string {
  return `/api/v1/stashes/demo/history/${path}`;
}

async function requireStatus(
  response: APIResponse,
  expected: number,
  operation: string,
): Promise<void> {
  if (response.status() === expected) return;
  const body = await response.text();
  throw new Error(
    `${operation} expected HTTP ${String(expected)}, received ${String(response.status())}: ${body}`,
  );
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function capturePageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function listedTokens(value: unknown): ListedToken[] {
  if (typeof value !== "object" || value === null || !("tokens" in value)) {
    throw new Error("token cleanup list did not contain a tokens array");
  }
  const tokens = value.tokens;
  if (!Array.isArray(tokens)) throw new Error("token cleanup list did not contain a tokens array");
  return tokens.map((token) => {
    if (typeof token !== "object" || token === null) {
      throw new Error("token cleanup list contained a malformed record");
    }
    const { id, label, revokedAt } = token as Partial<ListedToken>;
    if (
      typeof id !== "string" ||
      typeof label !== "string" ||
      (revokedAt !== null && typeof revokedAt !== "string")
    ) {
      throw new Error("token cleanup list contained a malformed record");
    }
    return { id, label, revokedAt };
  });
}

async function waitForDemo(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const demo = await request.get("/api/v1/stashes/demo", {
          headers: ADMIN_AUTHORIZATION,
        });
        if (demo.status() !== 200) return false;

        const historyResponse = await request.get(
          "/api/v1/stashes/demo/history/docs/guide.md?limit=200",
          { headers: ADMIN_AUTHORIZATION },
        );
        if (historyResponse.status() !== 200) return false;

        const history = (await historyResponse.json()) as HistoryResponse;
        const seededVersions = new Set(history.versions.map(({ version }) => version));
        return (
          history.headVersion >= 4 && [1, 2, 3, 4].every((version) => seededVersions.has(version))
        );
      },
      { message: "the deterministic demo seed should be complete", timeout: 30_000 },
    )
    .toBe(true);
}

async function cleanupUniqueResources(
  request: APIRequestContext,
  resources: LiveResources,
): Promise<Error[]> {
  const failures: Error[] = [];

  try {
    const head = await request.get(liveFileUrl(resources.path), {
      headers: ADMIN_AUTHORIZATION,
    });
    if (head.status() === 200) {
      const record = (await head.json()) as { version?: unknown };
      if (
        typeof record.version !== "number" ||
        !Number.isSafeInteger(record.version) ||
        record.version < 1
      ) {
        throw new Error("cleanup head did not include a positive integer version");
      }
      const expectedVersion = Number(record.version);
      const deleted = await request.post(`/api/v1/stashes/demo/delete/${resources.path}`, {
        headers: {
          ...ADMIN_AUTHORIZATION,
          "Idempotency-Key": idempotencyKey("cleanup-delete"),
        },
        data: {
          expectedVersion,
          author: "viewer-live-cleanup",
          message: "Remove the isolated browser fixture",
        },
      });
      await requireStatus(deleted, 200, `delete ${resources.path}`);
      const result = (await deleted.json()) as MutationResult;
      if (!Number.isSafeInteger(result.version) || result.version !== expectedVersion + 1) {
        throw new Error(
          `cleanup delete returned version ${String(result.version)} after v${String(expectedVersion)}`,
        );
      }

      const proof = await request.get(liveFileUrl(resources.path), {
        headers: ADMIN_AUTHORIZATION,
      });
      await requireStatus(proof, 404, `verify tombstone ${resources.path}`);
      const payload = (await proof.json()) as {
        error?: { code?: unknown };
        current?: { version?: unknown; deleted?: unknown };
      };
      if (
        payload.error?.code !== "file-deleted" ||
        payload.current?.version !== result.version ||
        payload.current.deleted !== true
      ) {
        throw new Error(`cleanup tombstone proof was malformed for ${resources.path}`);
      }
    } else if (head.status() === 404) {
      const payload = (await head.json()) as {
        error?: { code?: unknown };
        current?: { version?: unknown; deleted?: unknown };
      };
      const absent = payload.error?.code === "not-found";
      const tombstoned =
        payload.error?.code === "file-deleted" &&
        Number.isSafeInteger(payload.current?.version) &&
        payload.current?.deleted === true;
      if (!absent && !tombstoned) {
        throw new Error(`unique fixture ${resources.path} disappeared without a valid proof`);
      }
    } else {
      await requireStatus(head, 200, `read cleanup head ${resources.path}`);
    }
  } catch (error: unknown) {
    failures.push(errorFrom(error));
  }

  try {
    const beforeResponse = await request.get("/api/v1/stashes/demo/tokens", {
      headers: ADMIN_AUTHORIZATION,
    });
    await requireStatus(beforeResponse, 200, "list isolated tokens before cleanup");
    const before = listedTokens(await beforeResponse.json());
    const targetIds = new Set(
      before.filter(({ label }) => label === resources.tokenLabel).map(({ id }) => id),
    );
    if (resources.tokenId !== null) targetIds.add(resources.tokenId);
    if (targetIds.size > 1) {
      failures.push(
        new Error(`multiple tokens used the unique cleanup label ${resources.tokenLabel}`),
      );
    }
    if (targetIds.size === 0 && resources.tokenSecret !== null) {
      throw new Error(`could not recover the minted token for ${resources.tokenLabel}`);
    }

    for (const tokenId of targetIds) {
      const existing = before.find(({ id }) => id === tokenId);
      if (existing?.revokedAt === null || existing === undefined) {
        const revoked = await request.delete(`/api/v1/stashes/demo/tokens/${tokenId}`, {
          headers: ADMIN_AUTHORIZATION,
        });
        await requireStatus(revoked, 204, `revoke ${tokenId}`);
      }
    }

    if (targetIds.size > 0) {
      const afterResponse = await request.get("/api/v1/stashes/demo/tokens", {
        headers: ADMIN_AUTHORIZATION,
      });
      await requireStatus(afterResponse, 200, "list isolated tokens after cleanup");
      const after = listedTokens(await afterResponse.json());
      for (const tokenId of targetIds) {
        const proof = after.find(({ id }) => id === tokenId);
        if (typeof proof?.revokedAt !== "string" || proof.revokedAt.length === 0) {
          throw new Error(`token ${tokenId} did not expose revoked metadata after cleanup`);
        }
      }
    }

    if (resources.tokenSecret !== null) {
      const proof = await request.get("/api/v1/me", {
        headers: authorization(resources.tokenSecret),
      });
      await requireStatus(proof, 401, `verify revoked token for ${resources.tokenLabel}`);
      const payload = (await proof.json()) as { error?: { code?: unknown } };
      if (payload.error?.code !== "unauthorized") {
        throw new Error(`revoked token for ${resources.tokenLabel} did not fail closed`);
      }
    }
  } catch (error: unknown) {
    failures.push(errorFrom(error));
  }

  return failures;
}

test("@live viewer renders the seeded v2 to v3 CJK and CRLF diff", async ({ page, request }) => {
  const pageErrors = capturePageErrors(page);
  await waitForDemo(request);
  await page.addInitScript(({ token }) => sessionStorage.setItem("zhs.token", token), {
    token: ADMIN_TOKEN,
  });

  await page.goto("/s/demo/diff/docs/guide.md?from=2&to=3&context=3");

  const table = page.getByRole("table", { name: "Unified diff" });
  const removed = table.locator("del").filter({ hasText: "ガイド" }).first();
  const added = table.locator("ins").filter({ hasText: "Guide" }).first();
  await expect(table).toBeVisible();
  await expect(removed).toBeVisible();
  await expect(added).toBeVisible();
  await expect(
    page.getByText("CRLF line endings on the new side are shown normalized", { exact: true }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("@live viewer saves and rolls back an isolated file with a minted write token", async ({
  page,
  request,
}) => {
  const pageErrors = capturePageErrors(page);
  await waitForDemo(request);
  const runId = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const path = `e2e/${runId}.md`;
  const label = `viewer-live-${runId}`;
  const initialBody = `# Isolated ${runId}\n\nSeeded through the minted credential.\n`;
  const editedBody = `# Isolated ${runId}\n\nSaved through the browser workbench.\n`;
  const resources: LiveResources = {
    path,
    tokenLabel: label,
    tokenId: null,
    tokenSecret: null,
  };
  const browserMutations: string[] = [];
  page.on("request", (browserRequest) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(browserRequest.method())) return;
    browserMutations.push(`${browserRequest.method()} ${new URL(browserRequest.url()).pathname}`);
  });

  let primaryFailure: unknown = null;
  let cleanupFailures: Error[] = [];
  try {
    const mintResponse = await request.post("/api/v1/stashes/demo/tokens", {
      headers: ADMIN_AUTHORIZATION,
      data: { label, scope: "write" },
    });
    await requireStatus(mintResponse, 201, "mint isolated write token");
    const minted = (await mintResponse.json()) as MintedToken;
    if (typeof minted.id === "string") resources.tokenId = minted.id;
    if (typeof minted.token === "string") resources.tokenSecret = minted.token;
    expect(minted).toEqual({
      id: expect.stringMatching(/^tok_/u),
      token: expect.stringMatching(/^zhs_/u),
      label,
      scope: "write",
      createdAt: expect.any(String),
      expiresAt: null,
      rotatedFrom: null,
    });

    const seeded = await request.put(liveFileUrl(path), {
      headers: {
        ...authorization(minted.token),
        "Idempotency-Key": idempotencyKey("seed"),
      },
      data: {
        body: initialBody,
        expectedVersion: null,
        author: "viewer-live-seed",
        message: "Create isolated browser fixture",
      },
    });
    await requireStatus(seeded, 201, `create ${path} with minted credential`);
    const seedResult = (await seeded.json()) as MutationResult & {
      hash: string;
      size: number;
    };
    expect(seedResult).toMatchObject({
      version: 1,
      hash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/u),
      size: new TextEncoder().encode(initialBody).byteLength,
      changeId: expect.any(Number),
      createdAt: expect.any(String),
    });

    await page.addInitScript(({ token }) => sessionStorage.setItem("zhs.token", token), {
      token: minted.token,
    });
    await page.goto(`/s/demo/edit/${path}`);
    const editor = page.getByRole("textbox", { name: "Draft body" });
    await expect(editor).toHaveValue(initialBody);
    await editor.fill(editedBody);
    await expect(page.getByRole("button", { name: "Save…" })).toBeEnabled();
    await page.getByRole("button", { name: "Save…" }).click();

    const saveDialog = page.getByRole("dialog", { name: "Review save against head v1" });
    await saveDialog.getByRole("textbox", { name: "Author" }).fill("viewer-live-browser");
    await saveDialog.getByRole("textbox", { name: "Message" }).fill("Browser e2e save");
    await saveDialog.getByRole("button", { name: "Save v2" }).click();

    await expect(page).toHaveURL((url) => url.pathname === `/s/demo/f/${path}`);
    await expect(page.getByRole("status", { name: "Save confirmation" })).toContainText(
      "Saved v2.",
    );
    await expect(page.locator(".file-body-pane")).toHaveText(editedBody.trim());

    await page.goto(`/s/demo/edit/${path}`);
    const rail = page.getByRole("complementary", { name: "Version history" });
    const savedRailRow = rail.locator('[data-history-version="2"]');
    await expect(savedRailRow).toHaveAttribute("aria-current", "true");
    await expect(savedRailRow).toContainText("Browser e2e save");
    await expect(savedRailRow).toContainText("head");

    await page.goto(`/s/demo/f/${path}`);
    const history = page.getByRole("region", { name: "History" });
    await history.getByRole("button", { name: "Rollback to v1" }).click();
    const rollbackDialog = page.getByRole("dialog", { name: `Rollback ${path} to v1` });
    await expect(rollbackDialog.getByText("This creates v3 as a rollback to v1.")).toBeVisible();
    await rollbackDialog
      .getByRole("textbox", { name: "Message (optional)" })
      .fill("Restore isolated seed");
    await rollbackDialog.getByRole("button", { name: "Confirm rollback" }).click();

    await expect(rollbackDialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Rollback complete" })).toContainText(
      "Created v3 as rollback to v1.",
    );
    await expect(page.locator(".file-body-pane")).toHaveText(initialBody.trim());
    const rollbackRow = history.locator('[data-history-version="3"]');
    await expect(rollbackRow).toContainText("rollback");
    await expect(rollbackRow).toContainText("→ v1");

    const persistedResponse = await request.get(`${liveHistoryUrl(path)}?limit=200`, {
      headers: authorization(minted.token),
    });
    await requireStatus(persistedResponse, 200, `read persisted history for ${path}`);
    const persisted = (await persistedResponse.json()) as HistoryResponse;
    expect(persisted.headVersion).toBe(3);
    expect(persisted.total).toBe(3);
    expect(persisted.versions[0]).toMatchObject({
      version: 3,
      kind: "rollback",
      rollbackOf: 1,
      message: "Restore isolated seed",
    });
    expect(browserMutations).toEqual([
      `PUT /api/v1/stashes/demo/files/${path}`,
      `POST /api/v1/stashes/demo/rollback/${path}`,
    ]);
    expect(browserMutations.some((requestPath) => requestPath.includes(GUIDE_PATH))).toBe(false);
    expect(pageErrors).toEqual([]);
  } catch (error: unknown) {
    primaryFailure = error;
  } finally {
    cleanupFailures = await cleanupUniqueResources(request, resources);
  }

  if (primaryFailure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === null ? [] : [errorFrom(primaryFailure)]), ...cleanupFailures],
      "isolated live viewer flow or its verified cleanup failed",
    );
  }
});
