import type { APIRequestContext, APIResponse, Page, Response } from "@playwright/test";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { VIEWER_CLIENT_ID_STORAGE_KEY } from "../src/app/auth/stash-client-provider.js";
import { VIEWER_LIVE_POLL_INTERVAL_MS } from "../src/app/live-updates.js";
import { expect, test } from "./fixtures/console-errors.js";
import { requireLoopbackViewerUrl } from "./live-safety.js";

test.use({ mockLiveEvents: false });

const ADMIN_TOKEN = process.env.STASH_ADMIN_TOKEN ?? "dev-admin-token";
const ADMIN_AUTHORIZATION = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const GUIDE_PATH = "docs/guide.md";
const LARGE_FILE_BYTES = 1_500_000;
const LARGE_FILE_PREFIX = "History Stash R2 large-file fixture\n";
const LARGE_FILE_SUFFIX = "\nHistory Stash R2 large-file fixture end\n";
const LARGE_FILE_LINE = `${"x".repeat(4_095)}\n`;
const LIVE_REFRESH_DEADLINE_MS = VIEWER_LIVE_POLL_INTERVAL_MS - 5_000;

if (LIVE_REFRESH_DEADLINE_MS <= 0) {
  throw new Error("The live refresh deadline must remain below the polling interval");
}

test.beforeAll(({ baseURL }) => {
  requireLoopbackViewerUrl(baseURL ?? "");
});

interface HistoryResponse {
  total: number;
  headVersion: number;
  versions: Array<{
    version: number;
    kind: string;
    rollbackOf: number | null;
    author?: string;
    message?: string;
    meta?: Record<string, unknown>;
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

interface ChangeFeedResponse {
  changes: Array<{ changeId: number; path: string }>;
  hasMore: boolean;
  nextSince?: number | null;
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

interface StashLifecycleRecord {
  name: string;
  deletedAt: string | null;
  restoreUntil: string | null;
  restorable: boolean;
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function idempotencyKey(kind: string): string {
  return `viewer-live-${kind}-${globalThis.crypto.randomUUID()}`;
}

function largeFileBody(): string {
  const fillBytes = LARGE_FILE_BYTES - LARGE_FILE_PREFIX.length - LARGE_FILE_SUFFIX.length;
  const body = `${LARGE_FILE_PREFIX}${LARGE_FILE_LINE.repeat(
    Math.floor(fillBytes / LARGE_FILE_LINE.length),
  )}${"x".repeat(fillBytes % LARGE_FILE_LINE.length)}${LARGE_FILE_SUFFIX}`;
  if (body.length !== LARGE_FILE_BYTES) throw new Error("Large-file fixture size drifted");
  return body;
}

function liveFileUrl(path: string): string {
  return `/api/v1/stashes/demo/files/${path}`;
}

function liveHistoryUrl(path: string): string {
  return `/api/v1/stashes/demo/history/${path}`;
}

async function requireStatus(
  response: APIResponse | Response,
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

interface LiveAttributionEvidence {
  statusHistory: string[];
  focusEvents: number;
  visibilityEvents: number;
}

async function installLiveAttributionObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface ObserverState {
      statusHistory: string[];
      focusEvents: number;
      visibilityEvents: number;
      observer: MutationObserver;
      onFocus: () => void;
      onVisibilityChange: () => void;
    }
    type AttributionWindow = Window & { __zhsLiveAttribution?: ObserverState };
    const attributionWindow = window as AttributionWindow;
    attributionWindow.__zhsLiveAttribution?.observer.disconnect();

    const statusHistory: string[] = [];
    const record = (label: string | null) => {
      if (label === null || !label.startsWith("Live updates: ")) return;
      if (statusHistory.at(-1) !== label) statusHistory.push(label);
    };
    const recordNode = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('[role="status"][aria-label^="Live updates: "]')) {
        record(node.getAttribute("aria-label"));
      }
      for (const status of node.querySelectorAll('[role="status"][aria-label^="Live updates: "]')) {
        record(status.getAttribute("aria-label"));
      }
    };
    const recordCurrent = () => {
      for (const status of document.querySelectorAll(
        '[role="status"][aria-label^="Live updates: "]',
      )) {
        record(status.getAttribute("aria-label"));
      }
    };
    recordCurrent();
    if (statusHistory[0] !== "Live updates: live") {
      throw new Error("live attribution observer was installed before the live state was proven");
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          record(mutation.oldValue);
          record((mutation.target as Element).getAttribute("aria-label"));
          continue;
        }
        for (const removed of mutation.removedNodes) recordNode(removed);
        for (const added of mutation.addedNodes) recordNode(added);
      }
      recordCurrent();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
      attributeOldValue: true,
    });

    const state: ObserverState = {
      statusHistory,
      focusEvents: 0,
      visibilityEvents: 0,
      observer,
      onFocus: () => {
        state.focusEvents += 1;
      },
      onVisibilityChange: () => {
        state.visibilityEvents += 1;
      },
    };
    window.addEventListener("focus", state.onFocus);
    document.addEventListener("visibilitychange", state.onVisibilityChange);
    attributionWindow.__zhsLiveAttribution = state;
  });
}

async function takeLiveAttributionEvidence(page: Page): Promise<LiveAttributionEvidence> {
  return page.evaluate(() => {
    interface ObserverState {
      statusHistory: string[];
      focusEvents: number;
      visibilityEvents: number;
      observer: MutationObserver;
      onFocus: () => void;
      onVisibilityChange: () => void;
    }
    const state = (window as Window & { __zhsLiveAttribution?: ObserverState })
      .__zhsLiveAttribution;
    if (state === undefined) throw new Error("live attribution observer was not installed");
    state.observer.disconnect();
    window.removeEventListener("focus", state.onFocus);
    document.removeEventListener("visibilitychange", state.onVisibilityChange);
    return {
      statusHistory: [...state.statusHistory],
      focusEvents: state.focusEvents,
      visibilityEvents: state.visibilityEvents,
    };
  });
}

async function withinLiveRefreshDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    watchdog = setTimeout(() => {
      reject(
        new Error(
          `Live refresh exceeded ${String(LIVE_REFRESH_DEADLINE_MS)} ms; polling begins at ${String(VIEWER_LIVE_POLL_INTERVAL_MS)} ms`,
        ),
      );
    }, LIVE_REFRESH_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
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

async function cleanupLifecycleStash(request: APIRequestContext, stash: string): Promise<Error[]> {
  try {
    const existing = await request.get(`/api/v1/stashes/${stash}`, {
      headers: ADMIN_AUTHORIZATION,
    });
    if (existing.status() === 404) return [];
    await requireStatus(existing, 200, `read lifecycle cleanup stash ${stash}`);
    const record = (await existing.json()) as StashLifecycleRecord;
    if (record.deletedAt !== null) return [];

    const deleted = await request.delete(`/api/v1/stashes/${stash}`, {
      headers: ADMIN_AUTHORIZATION,
    });
    await requireStatus(deleted, 200, `delete lifecycle cleanup stash ${stash}`);
    return [];
  } catch (error: unknown) {
    return [errorFrom(error)];
  }
}

test("@live a foreign mutation refreshes the stash through SSE before polling", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const pageErrors = capturePageErrors(page);
  await waitForDemo(request);
  const runId = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const path = `e2e/live-refresh-${runId}.md`;
  const label = `viewer-live-refresh-${runId}`;
  const browserClientId = `viewer-tab-${runId}`;
  const mutationClientId = `foreign-writer-${runId}`;
  const body = `# Live refresh ${runId}\n\nDelivered through the event stream.\n`;
  const resources: LiveResources = {
    path,
    tokenLabel: label,
    tokenId: null,
    tokenSecret: null,
  };

  let primaryFailure: unknown = null;
  const cleanupFailures: Error[] = [];
  try {
    const mintResponse = await request.post("/api/v1/stashes/demo/tokens", {
      headers: ADMIN_AUTHORIZATION,
      data: { label, scope: "write" },
    });
    await requireStatus(mintResponse, 201, "mint live-refresh write token");
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

    const absent = await request.get(liveFileUrl(path), {
      headers: authorization(minted.token),
    });
    await requireStatus(absent, 404, `prove ${path} is initially absent`);
    expect(await absent.json()).toMatchObject({ error: { code: "not-found" } });

    await page.addInitScript(
      ({ clientId, clientIdKey, token }) => {
        sessionStorage.setItem("zhs.token", token);
        sessionStorage.setItem(clientIdKey, clientId);
      },
      { token: minted.token, clientId: browserClientId, clientIdKey: VIEWER_CLIENT_ID_STORAGE_KEY },
    );

    let fileListResponses = 0;
    let recentChangesResponses = 0;
    page.on("response", (response) => {
      if (response.request().method() !== "GET" || response.status() !== 200) return;
      const url = new URL(response.url());
      if (url.pathname === "/api/v1/stashes/demo/files") fileListResponses += 1;
      if (url.pathname === "/api/v1/stashes/demo/changes" && !url.searchParams.has("since")) {
        recentChangesResponses += 1;
      }
    });

    const eventsResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/v1/stashes/demo/events" &&
        response.status() === 200
      );
    });
    const readyRefreshPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/v1/stashes/demo/changes" &&
        url.searchParams.get("since") === "0" &&
        response.status() === 200
      );
    });

    await page.goto("/s/demo");
    const [eventsResponse, readyRefresh] = await Promise.all([
      eventsResponsePromise,
      readyRefreshPromise,
    ]);
    expect(eventsResponse.headers()["content-type"]).toContain("text/event-stream");
    const initialFeed = (await readyRefresh.json()) as ChangeFeedResponse;
    expect(Array.isArray(initialFeed.changes)).toBe(true);
    expect(initialFeed.hasMore).toBe(false);
    await expect.poll(() => fileListResponses).toBeGreaterThanOrEqual(2);
    await expect.poll(() => recentChangesResponses).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), VIEWER_CLIENT_ID_STORAGE_KEY),
    ).toBe(browserClientId);
    const liveIndicator = page.getByRole("status", { name: "Live updates: live" });
    await expect(liveIndicator).toBeVisible();
    await installLiveAttributionObserver(page);

    let authoritativeFeed: ChangeFeedResponse | undefined;
    const postMutationRefresh = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      if (
        response.request().method() !== "GET" ||
        url.pathname !== "/api/v1/stashes/demo/changes" ||
        !url.searchParams.has("since") ||
        response.status() !== 200
      ) {
        return false;
      }
      const candidate = (await response.json()) as ChangeFeedResponse;
      if (!candidate.changes.some((change) => change.path === path)) return false;
      authoritativeFeed = candidate;
      return true;
    });

    const startedAt = performance.now();
    await withinLiveRefreshDeadline(async () => {
      expect(mutationClientId).not.toBe(browserClientId);
      const put = await request.put(liveFileUrl(path), {
        headers: {
          ...authorization(minted.token),
          "Idempotency-Key": idempotencyKey("live-refresh"),
          "X-Stash-Client-Id": mutationClientId,
        },
        data: {
          body,
          expectedVersion: null,
          author: "viewer-live-foreign-writer",
          message: "Prove SSE-driven Viewer refresh",
        },
      });
      await requireStatus(put, 201, `create ${path} from a foreign client`);
      const mutation = (await put.json()) as MutationResult;
      expect(mutation).toMatchObject({ version: 1, changeId: expect.any(Number) });

      const refresh = await postMutationRefresh;
      await requireStatus(refresh, 200, `fetch authoritative live changes for ${path}`);
      expect(authoritativeFeed?.changes).toContainEqual(
        expect.objectContaining({ changeId: mutation.changeId, path }),
      );
      await expect(
        page.getByRole("region", { name: "Files" }).getByRole("link", { name: path, exact: true }),
      ).toBeVisible();
      await expect(liveIndicator).toBeVisible();
    });
    expect(performance.now() - startedAt).toBeLessThan(VIEWER_LIVE_POLL_INTERVAL_MS);
    const attribution = await takeLiveAttributionEvidence(page);
    expect(attribution.statusHistory.length).toBeGreaterThan(0);
    expect(attribution.statusHistory).toEqual(
      attribution.statusHistory.map(() => "Live updates: live"),
    );
    expect(attribution.focusEvents).toBe(0);
    expect(attribution.visibilityEvents).toBe(0);
    expect(pageErrors).toEqual([]);
  } catch (error: unknown) {
    primaryFailure = error;
  } finally {
    try {
      await page.close();
    } catch (error: unknown) {
      cleanupFailures.push(errorFrom(error));
    }
    cleanupFailures.push(...(await cleanupUniqueResources(request, resources)));
  }

  if (primaryFailure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === null ? [] : [errorFrom(primaryFailure)]), ...cleanupFailures],
      "SSE live-refresh proof or its verified logical cleanup failed",
    );
  }
});

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

test("@live viewer proxy round-trips a fixed 1.5 MB body with a minted write token", async ({
  request,
}) => {
  await waitForDemo(request);
  const runId = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const path = `e2e/large-${runId}.txt`;
  const label = `viewer-live-large-${runId}`;
  const resources: LiveResources = {
    path,
    tokenLabel: label,
    tokenId: null,
    tokenSecret: null,
  };

  let primaryFailure: unknown = null;
  const cleanupFailures: Error[] = [];
  try {
    const mintResponse = await request.post("/api/v1/stashes/demo/tokens", {
      headers: ADMIN_AUTHORIZATION,
      data: { label, scope: "write" },
    });
    await requireStatus(mintResponse, 201, "mint large-file write token");
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

    const body = largeFileBody();
    const hash = await sha256Hex(body);
    const put = await request.put(liveFileUrl(path), {
      headers: {
        ...authorization(minted.token),
        "Idempotency-Key": idempotencyKey("large-put"),
      },
      data: {
        body,
        expectedVersion: null,
        author: "viewer-live-large",
        message: "Create fixed 1.5 MB proxy fixture",
      },
    });
    await requireStatus(put, 201, `create ${path} through the viewer proxy`);
    const mutation = (await put.json()) as MutationResult & { hash: string; size: number };
    expect(mutation).toMatchObject({
      version: 1,
      hash,
      size: LARGE_FILE_BYTES,
      changeId: expect.any(Number),
      createdAt: expect.any(String),
    });

    const read = await request.get(liveFileUrl(path), {
      headers: authorization(minted.token),
    });
    await requireStatus(read, 200, `read ${path} through the viewer proxy`);
    expect(read.headers()["x-stash-version"]).toBe("1");
    expect(read.headers().etag).toBe(`"v1-${hash}"`);
    const record = (await read.json()) as {
      body?: unknown;
      deleted?: unknown;
      hash?: unknown;
      path?: unknown;
      size?: unknown;
      version?: unknown;
    };
    expect(record).toMatchObject({
      path,
      version: 1,
      hash,
      size: LARGE_FILE_BYTES,
      deleted: false,
      body,
    });
  } catch (error: unknown) {
    primaryFailure = error;
  } finally {
    cleanupFailures.push(...(await cleanupUniqueResources(request, resources)));
  }

  if (primaryFailure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === null ? [] : [errorFrom(primaryFailure)]), ...cleanupFailures],
      "large-file proxy flow or its verified logical cleanup failed",
    );
  }
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
  const cleanupFailures: Error[] = [];
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

    const fileRoute = `/s/demo/f/${path}`;
    const reconciledLoads = { file: 0, history: 0 };
    page.on("response", (response) => {
      if (response.request().method() !== "GET" || response.status() !== 200) return;
      const referer = response.request().headers().referer;
      if (referer === undefined || new URL(referer).pathname !== fileRoute) return;
      const url = new URL(response.url());
      let kind: keyof typeof reconciledLoads | undefined;
      if (url.pathname === liveFileUrl(path) && url.search === "") kind = "file";
      if (url.pathname === liveHistoryUrl(path) && url.search === "") kind = "history";
      if (kind === undefined) return;
      void response.finished().then((failure) => {
        if (failure === null) reconciledLoads[kind] += 1;
      });
    });

    await page.goto(fileRoute);
    const history = page.getByRole("region", { name: "History" });
    await expect
      .poll(() => Math.min(...Object.values(reconciledLoads)), {
        message: "the initial file page and ready-triggered live reconciliation should finish",
      })
      .toBeGreaterThanOrEqual(2);
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
    try {
      await page.close();
    } catch (error: unknown) {
      cleanupFailures.push(errorFrom(error));
    }
    cleanupFailures.push(...(await cleanupUniqueResources(request, resources)));
  }

  if (primaryFailure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === null ? [] : [errorFrom(primaryFailure)]), ...cleanupFailures],
      "isolated live viewer flow or its verified cleanup failed",
    );
  }
});

test("@live admin deletes and restores a unique stash through the viewer", async ({
  page,
  request,
}) => {
  const pageErrors = capturePageErrors(page);
  await waitForDemo(request);
  const runId = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const stash = `a-e2e-lifecycle-${runId}`;
  const browserMutations: string[] = [];
  page.on("request", (browserRequest) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(browserRequest.method())) return;
    browserMutations.push(`${browserRequest.method()} ${new URL(browserRequest.url()).pathname}`);
  });

  let primaryFailure: unknown = null;
  const cleanupFailures: Error[] = [];
  try {
    const created = await request.post("/api/v1/stashes", {
      headers: ADMIN_AUTHORIZATION,
      data: {
        name: stash,
        description: "Unique viewer lifecycle proof",
        meta: { fixture: "viewer-live-lifecycle" },
      },
    });
    await requireStatus(created, 201, `create lifecycle stash ${stash}`);

    await page.addInitScript(({ token }) => sessionStorage.setItem("zhs.token", token), {
      token: ADMIN_TOKEN,
    });
    const stashRoute = `/s/${stash}`;
    const reconciledLoads = { files: 0, changes: 0 };
    page.on("response", (response) => {
      if (response.request().method() !== "GET" || response.status() !== 200) return;
      const referer = response.request().headers().referer;
      if (referer === undefined || new URL(referer).pathname !== stashRoute) return;
      const url = new URL(response.url());
      let kind: keyof typeof reconciledLoads | undefined;
      if (
        url.pathname === `/api/v1/stashes/${stash}/files` &&
        url.searchParams.get("includeDeleted") === "false" &&
        !url.searchParams.has("after")
      ) {
        kind = "files";
      }
      if (url.pathname === `/api/v1/stashes/${stash}/changes` && url.search === "") {
        kind = "changes";
      }
      if (kind === undefined) return;
      void response.finished().then((failure) => {
        if (failure === null) reconciledLoads[kind] += 1;
      });
    });
    await page.goto(stashRoute);
    await expect(page.getByRole("heading", { name: stash, exact: true })).toBeVisible();
    await expect
      .poll(() => Math.min(...Object.values(reconciledLoads)), {
        message:
          "the lifecycle page's initial and ready-triggered files and changes should finish",
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("button", { name: "Delete stash" }).click();

    const dialog = page.getByRole("dialog", { name: `Delete ${stash}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("All current tokens will be revoked")).toBeVisible();
    await dialog.getByRole("button", { name: "Delete stash" }).click();
    await expect(dialog.getByText("Stash deleted and hidden.", { exact: true })).toBeVisible();
    const deadline = dialog.locator("time");
    await expect(deadline).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/u);
    await expect(dialog.getByText("former tokens remain revoked", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/");

    await page.getByRole("checkbox", { name: "Show deleted" }).check();
    const deletedRow = page.getByRole("row").filter({ hasText: stash });
    await expect(deletedRow).toContainText("deleted");
    await deletedRow.getByRole("button", { name: `Restore ${stash}` }).click();
    await expect(deletedRow).toContainText("live");
    await expect(deletedRow.getByRole("link", { name: stash, exact: true })).toBeVisible();

    const restoredResponse = await request.get(`/api/v1/stashes/${stash}`, {
      headers: ADMIN_AUTHORIZATION,
    });
    await requireStatus(restoredResponse, 200, `read restored lifecycle stash ${stash}`);
    const restored = (await restoredResponse.json()) as StashLifecycleRecord;
    expect(restored).toMatchObject({
      name: stash,
      deletedAt: null,
      restoreUntil: null,
      restorable: false,
    });
    expect(browserMutations).toEqual([
      `DELETE /api/v1/stashes/${stash}`,
      `POST /api/v1/stashes/${stash}/restore`,
    ]);
    expect(pageErrors).toEqual([]);
  } catch (error: unknown) {
    primaryFailure = error;
  } finally {
    try {
      await page.close();
    } catch (error: unknown) {
      cleanupFailures.push(errorFrom(error));
    }
    cleanupFailures.push(...(await cleanupLifecycleStash(request, stash)));
  }

  if (primaryFailure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === null ? [] : [errorFrom(primaryFailure)]), ...cleanupFailures],
      "viewer stash lifecycle flow or its verified cleanup failed",
    );
  }
});

test("@live admin runs an R2 garbage-collection dry page through the viewer", async ({
  page,
  request,
}) => {
  const pageErrors = capturePageErrors(page);
  await waitForDemo(request);
  await page.addInitScript(({ token }) => sessionStorage.setItem("zhs.token", token), {
    token: ADMIN_TOKEN,
  });
  await page.goto("/");

  const maintenance = page.getByRole("region", { name: "Maintenance" });
  await expect(maintenance).toBeVisible();
  await expect(maintenance.getByRole("checkbox", { name: /Dry run/u })).toBeChecked();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/admin/gc",
  );
  await maintenance.getByRole("button", { name: "Run", exact: true }).click();
  const response = await responsePromise;
  await requireStatus(response, 200, "run viewer R2 GC dry page");
  expect(response.request().postDataJSON()).toEqual({
    kind: "r2-orphans",
    dryRun: true,
    maxObjects: 100,
  });
  const result = (await response.json()) as {
    runId: string;
    jobId: string;
    kind: string;
    dryRun: boolean;
    deleted: number;
  };
  expect(result).toMatchObject({
    runId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    jobId: "r2-orphans",
    kind: "r2-orphans",
    dryRun: true,
    deleted: 0,
  });

  const currentRun = maintenance.getByRole("region", { name: "Current run" });
  await expect(currentRun).toContainText("Dry run");
  await expect(currentRun).toContainText(result.runId);
  await expect(currentRun).toContainText("r2-orphans");
  await expect(currentRun).toContainText("none");
  expect(pageErrors).toEqual([]);
});
