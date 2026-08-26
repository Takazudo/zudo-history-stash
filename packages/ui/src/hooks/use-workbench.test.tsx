import {
  createStashClient,
  type FileGetResult,
  type FileRecordWithEtag,
  type StashClient,
  type StashFetch,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { DIFF_MAX_BYTES } from "@takazudo/zudo-history-stash-core";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import {
  clearWorkbenchDraftsForLogout,
  useWorkbench,
  workbenchDraftKey,
  type SourceLoadResult,
  type UseWorkbenchOptions,
} from "./use-workbench.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "workbench-admin";
const STASH = "notes";
const PATH = "docs/readme.txt";
const OTHER_PATH = "docs/other.txt";

interface Fixture {
  client: StashClient;
  fetches: Request[];
  put: (path: string, body: string) => Promise<FileRecordWithEtag>;
  remove: (path: string) => Promise<FileRecordWithEtag>;
  load: (path: string, version?: number) => Promise<FileRecordWithEtag>;
}

async function fixtureWith(
  entries: Record<string, readonly string[]> = { [PATH]: ["base\n", "head\n"] },
  fetchWrapper?: (fakeFetch: StashFetch) => StashFetch,
): Promise<Fixture> {
  let now = Date.UTC(2026, 7, 25);
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN, now: () => now++ });
  fake.createStash(STASH);
  const fetches: Request[] = [];
  const observedFetch: StashFetch = async (input, init) => {
    fetches.push(new Request(input, init));
    return fake.fetch(input, init);
  };
  const fetch = fetchWrapper?.(observedFetch) ?? observedFetch;
  const client = createStashClient({
    baseUrl: BASE_URL,
    token: ADMIN_TOKEN,
    fetch,
  });

  for (const [path, bodies] of Object.entries(entries)) {
    let expectedVersion: number | null = null;
    for (const [index, body] of bodies.entries()) {
      const result = await client.files(STASH).put(path, {
        body,
        expectedVersion,
        author: "Fixture",
        message: `version ${index + 1}`,
      });
      if (!result.ok) throw new Error(result.error.message);
      expectedVersion = result.value.version;
    }
  }
  fetches.length = 0;

  async function load(path: string, version?: number): Promise<FileRecordWithEtag> {
    const result = await client
      .files(STASH)
      .get(path, version === undefined ? undefined : { version });
    if (!result.ok || "notModified" in result) throw new Error("Fixture record did not load");
    return result.value;
  }

  return {
    client,
    fetches,
    load,
    async put(path, body) {
      const current = await load(path);
      const result = await client.files(STASH).put(path, {
        body,
        expectedVersion: current.version,
        author: "Remote",
        message: "remote update",
      });
      if (!result.ok) throw new Error(result.error.message);
      return load(path);
    },
    async remove(path) {
      const current = await load(path);
      const result = await client.files(STASH).delete(path, {
        expectedVersion: current.version,
        author: "Remote",
        message: "delete",
      });
      if (!result.ok) throw new Error(result.error.message);
      return load(path, result.value.version);
    },
  };
}

function providerFor(client: StashClient, clientForSignal?: (signal: AbortSignal) => StashClient) {
  return function Provider({ children }: PropsWithChildren) {
    return (
      <StashUiProvider client={client} clientForSignal={clientForSignal}>
        {children}
      </StashUiProvider>
    );
  };
}

async function ready(result: { current: { state: string } }): Promise<void> {
  await waitFor(() => expect(result.current.state).toBe("ready"));
}

function getRequests(fixture: Fixture, fragment: string): Request[] {
  return fixture.fetches.filter(
    (request) => request.method === "GET" && new URL(request.url).pathname.includes(fragment),
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("useWorkbench", () => {
  it("keeps A, B, head, and draft separate and requires explicit resolution before discarding", async () => {
    const fixture = await fixtureWith();
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);
    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.comparison?.version).toBe(2);
    expect(rendered.result.current.comparisonMode).toBe("head");

    act(() => rendered.result.current.setDraft("local draft\n"));
    expect(rendered.result.current.dirtyFromSource).toBe(true);
    const getsBeforePrompt = getRequests(fixture, `/files/${PATH}`).length;
    let request!: SourceLoadResult;
    await act(async () => {
      request = await rendered.result.current.loadSource(1);
    });
    expect(request.status).toBe("confirmation-required");
    expect(getRequests(fixture, `/files/${PATH}`)).toHaveLength(getsBeforePrompt);

    if (request.status !== "confirmation-required") throw new Error("Expected confirmation");
    const cancelRequest = request.resolve;
    await act(async () => {
      expect(await cancelRequest(false)).toEqual({ status: "cancelled" });
    });
    expect(rendered.result.current.draft).toBe("local draft\n");
    expect(rendered.result.current.source?.version).toBe(2);

    await act(async () => {
      request = await rendered.result.current.loadSource(1);
    });
    if (request.status !== "confirmation-required") throw new Error("Expected confirmation");
    const confirmRequest = request.resolve;
    await act(async () => {
      const resolved = await confirmRequest(true);
      expect(resolved).toMatchObject({ status: "loaded", source: { version: 1 } });
    });
    expect(rendered.result.current.source?.version).toBe(1);
    expect(rendered.result.current.head?.version).toBe(2);
    expect(rendered.result.current.comparison?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("base\n");
    expect(rendered.result.current.dirtyFromSource).toBe(false);
  });

  it("loads a tombstone source as an empty draft with an explicit notice", async () => {
    const fixture = await fixtureWith({ [PATH]: ["alive\n"] });
    const tombstone = await fixture.remove(PATH);
    const rendered = renderHook(
      () => useWorkbench({ stash: STASH, path: PATH, initialSource: tombstone.version }),
      { wrapper: providerFor(fixture.client) },
    );
    await ready(rendered.result);

    expect(rendered.result.current.source).toMatchObject({
      version: tombstone.version,
      deleted: true,
      body: null,
    });
    expect(rendered.result.current.draft).toBe("");
    expect(rendered.result.current.sourceNotice).toContain("deletion");
    expect(rendered.result.current.dirtyFromSource).toBe(false);
  });

  it("preserves pinned B across stale reloads and moves B only in head mode", async () => {
    const fixture = await fixtureWith();
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    await act(async () => {
      expect(await rendered.result.current.setComparison(1)).toBe(true);
    });
    expect(rendered.result.current.comparisonMode).toBe(1);
    expect(rendered.result.current.comparison?.version).toBe(1);
    const third = await fixture.put(PATH, "third\n");
    act(() => rendered.result.current.afterStaleReload(third));
    expect(rendered.result.current.head?.version).toBe(3);
    expect(rendered.result.current.comparisonMode).toBe(1);
    expect(rendered.result.current.comparison?.version).toBe(1);

    await act(async () => {
      expect(await rendered.result.current.setComparison("head")).toBe(true);
    });
    const fourth = await fixture.put(PATH, "fourth\n");
    act(() => rendered.result.current.afterStaleReload(fourth));
    expect(rendered.result.current.head?.version).toBe(4);
    expect(rendered.result.current.comparisonMode).toBe("head");
    expect(rendered.result.current.comparison?.version).toBe(4);
    expect(rendered.result.current.source?.version).toBe(2);
  });

  it("sequence-fences concurrent comparison and source version reads", async () => {
    const fixture = await fixtureWith({ [PATH]: ["one\n", "two\n", "three\n"] });
    const firstRecord = await fixture.load(PATH, 1);
    const secondRecord = await fixture.load(PATH, 2);
    const files = fixture.client.files(STASH);
    let resolveFirstComparison!: (result: FileGetResult) => void;
    let resolveSecondComparison!: (result: FileGetResult) => void;
    const firstComparison = new Promise<FileGetResult>((resolve) => {
      resolveFirstComparison = resolve;
    });
    const secondComparison = new Promise<FileGetResult>((resolve) => {
      resolveSecondComparison = resolve;
    });
    const get = vi.fn<StashFilesClient["get"]>((requestedPath, options) => {
      if (options?.version === 1) return firstComparison;
      if (options?.version === 2) return secondComparison;
      return files.get(requestedPath, options);
    });
    vi.spyOn(fixture.client, "files").mockImplementation(() => ({ ...files, get }));
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    let firstSelection!: Promise<boolean>;
    let secondSelection!: Promise<boolean>;
    act(() => {
      firstSelection = rendered.result.current.setComparison(1);
    });
    act(() => {
      secondSelection = rendered.result.current.setComparison(2);
    });
    await act(async () => resolveSecondComparison({ ok: true, value: secondRecord }));
    await expect(secondSelection).resolves.toBe(true);
    await act(async () => resolveFirstComparison({ ok: true, value: firstRecord }));
    await expect(firstSelection).resolves.toBe(false);
    expect(rendered.result.current.comparisonMode).toBe(2);
    expect(rendered.result.current.comparison?.version).toBe(2);

    let resolveFirstSource!: (result: FileGetResult) => void;
    const firstSource = new Promise<FileGetResult>((resolve) => {
      resolveFirstSource = resolve;
    });
    get.mockImplementation((requestedPath, options) => {
      if (options?.version === 1) return firstSource;
      return files.get(requestedPath, options);
    });
    let staleSource!: Promise<SourceLoadResult>;
    act(() => {
      staleSource = rendered.result.current.loadSource(1);
    });
    await act(async () => {
      expect(await rendered.result.current.loadSource(2)).toMatchObject({
        status: "loaded",
        source: { version: 2 },
      });
    });
    await act(async () => resolveFirstSource({ ok: true, value: firstRecord }));
    await expect(staleSource).resolves.toEqual({ status: "cancelled" });
    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("two\n");
  });

  it("persists and safely restores draft metadata across a switch away and back", async () => {
    const fixture = await fixtureWith({
      [PATH]: ["first\n"],
      [OTHER_PATH]: ["other\n"],
    });
    const rendered = renderHook(
      ({ path }: UseWorkbenchOptions) => useWorkbench({ stash: STASH, path }),
      {
        initialProps: { stash: STASH, path: PATH },
        wrapper: providerFor(fixture.client),
      },
    );
    await ready(rendered.result);
    const oldSetDraft = rendered.result.current.setDraft;
    act(() => rendered.result.current.setDraft("restored edit\n"));
    const serialized = sessionStorage.getItem(workbenchDraftKey(STASH, PATH));
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized ?? "null")).toMatchObject({
      sourceVersion: 1,
      fenceVersion: 1,
      text: "restored edit\n",
      lineEnding: "lf",
    });

    rendered.rerender({ stash: STASH, path: OTHER_PATH });
    expect(rendered.result.current.state).toBe("loading");
    expect(rendered.result.current.source).toBeNull();
    expect(rendered.result.current.draft).toBe("");
    act(() => oldSetDraft("must not leak\n"));
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, OTHER_PATH))).toBeNull();
    await ready(rendered.result);
    expect(rendered.result.current.draft).toBe("other\n");

    rendered.rerender({ stash: STASH, path: PATH });
    expect(rendered.result.current.state).toBe("loading");
    await ready(rendered.result);
    expect(rendered.result.current.source?.version).toBe(1);
    expect(rendered.result.current.draft).toBe("restored edit\n");
    expect(rendered.result.current.draftRestored).toBe(true);
    expect(rendered.result.current.dirtyFromSource).toBe(true);
  });

  it("rejects draft metadata that cannot be safely reconciled with the current fence", async () => {
    const fixture = await fixtureWith();
    sessionStorage.setItem(
      workbenchDraftKey(STASH, PATH),
      JSON.stringify({
        sourceVersion: 1,
        fenceVersion: 99,
        text: "unsafe edit\n",
        lineEnding: "lf",
        savedAt: Date.now(),
      }),
    );
    sessionStorage.setItem(workbenchDraftKey(STASH, OTHER_PATH), "unrelated draft");
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("head\n");
    expect(rendered.result.current.draftRestored).toBe(false);
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, OTHER_PATH))).toBe("unrelated draft");
  });

  it("clears a non-dirty stored draft and starts from authoritative head", async () => {
    const fixture = await fixtureWith();
    sessionStorage.setItem(
      workbenchDraftKey(STASH, PATH),
      JSON.stringify({
        sourceVersion: 1,
        fenceVersion: 2,
        text: "base\n",
        lineEnding: "lf",
        savedAt: Date.now(),
      }),
    );
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("head\n");
    expect(rendered.result.current.draftRestored).toBe(false);
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
  });

  it("falls back to head and clears storage when a storage-only source is missing", async () => {
    const fixture = await fixtureWith();
    sessionStorage.setItem(
      workbenchDraftKey(STASH, PATH),
      JSON.stringify({
        sourceVersion: 99,
        fenceVersion: 99,
        text: "orphaned draft\n",
        lineEnding: "lf",
        savedAt: Date.now(),
      }),
    );
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("head\n");
    expect(rendered.result.current.draftRestored).toBe(false);
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();

    rendered.unmount();
    const explicit = renderHook(
      () => useWorkbench({ stash: STASH, path: PATH, initialSource: 99 }),
      { wrapper: providerFor(fixture.client) },
    );
    await waitFor(() => expect(explicit.result.current.state).toBe("error"));
    expect(explicit.result.current.source).toBeNull();
  });

  it("surfaces a transient stored-source failure without deleting the draft", async () => {
    const fixture = await fixtureWith(undefined, (fakeFetch) => async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname.endsWith(`/files/${PATH}`) &&
        url.searchParams.get("version") === "1"
      ) {
        throw new TypeError("temporary network failure");
      }
      return fakeFetch(input, init);
    });
    const key = workbenchDraftKey(STASH, PATH);
    const serialized = JSON.stringify({
      sourceVersion: 1,
      fenceVersion: 2,
      text: "unsaved draft\n",
      lineEnding: "lf",
      savedAt: Date.now(),
    });
    sessionStorage.setItem(key, serialized);
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });

    await waitFor(() => expect(rendered.result.current.state).toBe("error"));
    expect(rendered.result.current.error).toBeTruthy();
    expect(rendered.result.current.source).toBeNull();
    expect(sessionStorage.getItem(key)).toBe(serialized);
  });

  it("reports a storage error when an unsafe draft cannot be cleared", async () => {
    const fixture = await fixtureWith();
    sessionStorage.setItem(
      workbenchDraftKey(STASH, PATH),
      JSON.stringify({
        sourceVersion: 1,
        fenceVersion: 99,
        text: "unsafe edit\n",
        lineEnding: "lf",
        savedAt: Date.now(),
      }),
    );
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    expect(rendered.result.current.source?.version).toBe(2);
    expect(rendered.result.current.draft).toBe("head\n");
    expect(rendered.result.current.draftPersistError).toBe("draft not persisted");
  });

  it("clears drafts on discard and logout and reports storage quota failures", async () => {
    const fixture = await fixtureWith({ [PATH]: ["base\n"] });
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);

    act(() => rendered.result.current.setDraft("dirty\n"));
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).not.toBeNull();
    act(() => rendered.result.current.discard());
    expect(rendered.result.current.draft).toBe("base\n");
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();

    sessionStorage.setItem(workbenchDraftKey(STASH, OTHER_PATH), "fixture");
    act(() => rendered.result.current.setDraft("dirty again\n"));
    expect(rendered.result.current.clearForLogout()).toBe(true);
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, OTHER_PATH))).toBeNull();
    expect(clearWorkbenchDraftsForLogout()).toBe(true);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    act(() => rendered.result.current.setDraft("cannot persist\n"));
    expect(rendered.result.current.draft).toBe("cannot persist\n");
    expect(rendered.result.current.draftPersistError).toBe("draft not persisted");
  });

  it("detects CRLF from any source CRLF and hashes the exact re-applied save bytes", async () => {
    const fixture = await fixtureWith({ [PATH]: ["first\r\nsecond\r\n"] });
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);
    await waitFor(() => expect(rendered.result.current.sameAsHeadPending).toBe(false));

    expect(rendered.result.current.lineEnding).toBe("crlf");
    expect(rendered.result.current.draft).toBe("first\nsecond\n");
    expect(rendered.result.current.frozenBody).toBe("first\r\nsecond\r\n");
    expect(rendered.result.current.sameAsHead).toBe(true);

    act(() => rendered.result.current.setDraft("first\nsecond\nthird\n"));
    expect(rendered.result.current.frozenBody).toBe("first\r\nsecond\r\nthird\r\n");
    expect(
      JSON.parse(sessionStorage.getItem(workbenchDraftKey(STASH, PATH)) ?? "null"),
    ).toMatchObject({
      text: "first\nsecond\nthird\n",
      lineEnding: "crlf",
    });
  });

  it("derives sameAsHead by SHA-256 even when the visible B diff is oversized", async () => {
    const headBody = `${"x".repeat(DIFF_MAX_BYTES + 1)}\n`;
    const fixture = await fixtureWith({ [PATH]: ["small\n", headBody] });
    const rendered = renderHook(
      () => useWorkbench({ stash: STASH, path: PATH, initialSource: 1 }),
      { wrapper: providerFor(fixture.client) },
    );
    await ready(rendered.result);
    await act(async () => {
      expect(await rendered.result.current.setComparison(1)).toBe(true);
    });
    act(() => rendered.result.current.setDraft(headBody));

    await waitFor(
      () => {
        expect(rendered.result.current.sameAsHeadPending).toBe(false);
        expect(rendered.result.current.sameAsHead).toBe(true);
        expect(rendered.result.current.displayDiffPending).toBe(false);
        expect(rendered.result.current.displayDiff.oversized).toBe(true);
      },
      { timeout: 4_000 },
    );
  });

  it("updates the saved source/head, preserves pinned B, clears storage, and refreshes history", async () => {
    const fixture = await fixtureWith();
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: providerFor(fixture.client),
    });
    await ready(rendered.result);
    const stableReload = rendered.result.current.reloadHistory;
    await act(async () => {
      await rendered.result.current.setComparison(1);
    });
    act(() => rendered.result.current.setDraft("local\n"));
    const historiesBefore = getRequests(fixture, `/history/${PATH}`).length;
    const saved = await fixture.put(PATH, "saved\r\nbody\r\n");

    await act(async () => {
      expect(await rendered.result.current.afterSaved(saved)).toBe(true);
    });
    expect(rendered.result.current.reloadHistory).toBe(stableReload);
    expect(getRequests(fixture, `/history/${PATH}`)).toHaveLength(historiesBefore + 1);
    expect(rendered.result.current.head?.version).toBe(3);
    expect(rendered.result.current.source?.version).toBe(3);
    expect(rendered.result.current.draft).toBe("saved\nbody\n");
    expect(rendered.result.current.lineEnding).toBe("crlf");
    expect(rendered.result.current.comparisonMode).toBe(1);
    expect(rendered.result.current.comparison?.version).toBe(1);
    expect(rendered.result.current.versions[0]?.version).toBe(3);
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
  });

  it("aborts and sequence-fences old target reads, including client replacement", async () => {
    let releaseOld = () => {};
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldFixture = await fixtureWith(
      { [PATH]: ["old target\n"] },
      (fakeFetch) => async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET" && new URL(request.url).pathname.includes("docs/readme.txt")) {
          await oldGate;
        }
        return fakeFetch(input, init);
      },
    );
    const nextFixture = await fixtureWith({ [PATH]: ["new target\n"] });
    const oldSignals: AbortSignal[] = [];
    let activeClient = oldFixture.client;
    function Provider({ children }: PropsWithChildren) {
      return (
        <StashUiProvider
          client={activeClient}
          clientForSignal={(signal) => {
            if (activeClient === oldFixture.client) oldSignals.push(signal);
            return activeClient;
          }}
        >
          {children}
        </StashUiProvider>
      );
    }
    const rendered = renderHook(() => useWorkbench({ stash: STASH, path: PATH }), {
      wrapper: Provider,
    });
    await waitFor(() => expect(oldFixture.fetches.length).toBeGreaterThan(0));
    const oldCallback = rendered.result.current.setDraft;

    activeClient = nextFixture.client;
    rendered.rerender();
    expect(rendered.result.current.state).toBe("loading");
    expect(rendered.result.current.head).toBeNull();
    expect(oldSignals.some((signal) => signal.aborted)).toBe(true);
    act(() => oldCallback("old callback leak\n"));
    await ready(rendered.result);
    expect(rendered.result.current.draft).toBe("new target\n");

    await act(async () => releaseOld());
    expect(rendered.result.current.draft).toBe("new target\n");
    expect(rendered.result.current.head?.version).toBe(1);
  });
});
