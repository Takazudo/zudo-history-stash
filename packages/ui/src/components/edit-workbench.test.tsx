import {
  createStashClient,
  type FileRecordWithEtag,
  type ProposalRecord,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchDraftKey } from "../hooks/use-workbench.js";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import {
  EditWorkbench,
  type EditWorkbenchLiveRefresh,
  type EditWorkbenchSaved,
} from "./edit-workbench.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "workbench-admin";
const STASH = "notes";
const PATH = "docs/readme.txt";

interface Fixture {
  fake: FakeStash;
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  remoteClient: StashClient;
  requests: Request[];
}

function requestFetch(fake: FakeStash, requests: Request[]): StashFetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    return fake.fetch(input, init);
  };
}

function signalFetch(fetch: StashFetch, signal: AbortSignal): StashFetch {
  return (input, init) => fetch(input, init?.signal ? init : { ...init, signal });
}

async function put(
  client: StashClient,
  body: string,
  expectedVersion: number | null,
  author = "Fixture",
  message = `Write ${String((expectedVersion ?? 0) + 1)}`,
): Promise<FileRecordWithEtag> {
  const result = await client.files(STASH).put(PATH, {
    body,
    expectedVersion,
    author,
    message,
  });
  if (!result.ok) throw new Error(result.error.message);
  const record = await client.files(STASH).get(PATH, { version: result.value.version });
  if (!record.ok || "notModified" in record) throw new Error("Fixture record did not load");
  return record.value;
}

function delayVersionRead(
  fixture: Fixture,
  version: number,
): {
  fixture: Fixture;
  started: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let markStarted!: () => void;
  let delayed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetch: StashFetch = async (input, init) => {
    const request = new Request(input, init);
    fixture.requests.push(request);
    const url = new URL(request.url);
    if (
      !delayed &&
      request.method === "GET" &&
      url.pathname === `/v1/stashes/${STASH}/files/${PATH}` &&
      url.searchParams.get("version") === String(version)
    ) {
      delayed = true;
      markStarted();
      await gate;
    }
    return fixture.fake.fetch(input, init);
  };
  return {
    fixture: {
      ...fixture,
      client: createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch }),
      clientForSignal: (signal) =>
        createStashClient({
          baseUrl: BASE_URL,
          token: ADMIN_TOKEN,
          fetch: signalFetch(fetch, signal),
        }),
    },
    started,
    release,
  };
}

async function createFixture(): Promise<Fixture> {
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
  fake.createStash(STASH);
  const remoteClient = createStashClient({
    baseUrl: BASE_URL,
    token: ADMIN_TOKEN,
    fetch: fake.fetch,
  });
  await put(remoteClient, "alpha\nfirst\n", null);
  await put(remoteClient, "alpha\nhead\n", 1);

  const requests: Request[] = [];
  const fetch = requestFetch(fake, requests);
  const client = createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch });
  return {
    fake,
    client,
    clientForSignal: (signal) =>
      createStashClient({
        baseUrl: BASE_URL,
        token: ADMIN_TOKEN,
        fetch: signalFetch(fetch, signal),
      }),
    remoteClient,
    requests,
  };
}

function renderWorkbench(
  fixture: Fixture,
  {
    initialSource,
    onProposed,
    onSaved,
    registerLiveRefresh,
  }: {
    initialSource?: number;
    onProposed?: (record: ProposalRecord) => void;
    onSaved?: (result: EditWorkbenchSaved) => void;
    registerLiveRefresh?: (refresh: EditWorkbenchLiveRefresh) => () => void;
  } = {},
) {
  return render(
    <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
      <EditWorkbench
        initialSource={initialSource}
        path={PATH}
        registerLiveRefresh={registerLiveRefresh}
        stash={STASH}
        onProposed={onProposed}
        onSaved={onSaved}
      />
    </StashUiProvider>,
  );
}

function mockNarrowViewport(narrow: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(max-width: 56rem)" && narrow,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mutationRequests(fixture: Fixture): Request[] {
  return fixture.requests.filter((request) => request.method === "PUT");
}

async function readyEditor(): Promise<HTMLTextAreaElement> {
  return (await screen.findByRole("textbox", { name: "Draft body" })) as HTMLTextAreaElement;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockNarrowViewport(false);
});

describe("EditWorkbench", () => {
  it("refreshes history but marks stale only when the host verifies a foreign same-path change", async () => {
    const fixture = await createFixture();
    const liveRefreshRef: { current: EditWorkbenchLiveRefresh | null } = { current: null };
    renderWorkbench(fixture, {
      registerLiveRefresh(refresh) {
        liveRefreshRef.current = refresh;
        return () => {
          if (liveRefreshRef.current === refresh) liveRefreshRef.current = null;
        };
      },
    });
    const editor = await readyEditor();
    fireEvent.change(editor, { target: { value: "keep this dirty draft\n" } });
    await waitFor(() => expect(liveRefreshRef.current).not.toBeNull());

    const remote = await put(
      fixture.remoteClient,
      "foreign body\n",
      2,
      "Peer",
      "Foreign live update",
    );
    const refresh = liveRefreshRef.current;
    if (refresh === null) throw new Error("Live refresh did not register");

    await act(async () =>
      refresh({ reconcileCurrentHead: false, signal: new AbortController().signal }),
    );
    expect(editor.value).toBe("keep this dirty draft\n");
    expect(screen.queryByText(/Head moved to v/u)).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Version history" }).textContent).toContain(
        "Foreign live update",
      ),
    );

    await act(async () =>
      refresh({ reconcileCurrentHead: true, signal: new AbortController().signal }),
    );
    expect(await screen.findByText(`Head moved to v${remote.version} by Peer`)).toBeTruthy();
    expect(editor.value).toBe("keep this dirty draft\n");
    expect(screen.getByText(/remains fenced to v2/u)).toBeTruthy();
  });

  it("rejects the host refresh when the authoritative history reload fails", async () => {
    const fixture = await createFixture();
    const originalClientForSignal = fixture.clientForSignal;
    let failHistory = false;
    fixture.clientForSignal = (signal) => {
      const client = originalClientForSignal(signal);
      return {
        ...client,
        files(stash) {
          const files = client.files(stash);
          return {
            ...files,
            history(path, options) {
              if (failHistory) {
                failHistory = false;
                return Promise.resolve({
                  ok: false as const,
                  error: {
                    status: 503,
                    code: "internal" as const,
                    message: "history refresh failed",
                  },
                });
              }
              return files.history(path, options);
            },
          };
        },
      };
    };
    const liveRefreshRef: { current: EditWorkbenchLiveRefresh | null } = { current: null };
    renderWorkbench(fixture, {
      registerLiveRefresh(refresh) {
        liveRefreshRef.current = refresh;
        return () => {
          if (liveRefreshRef.current === refresh) liveRefreshRef.current = null;
        };
      },
    });
    await readyEditor();
    await waitFor(() => expect(liveRefreshRef.current).not.toBeNull());
    failHistory = true;
    const refresh = liveRefreshRef.current;
    if (refresh === null) throw new Error("Live refresh did not register");

    await expect(
      refresh({ reconcileCurrentHead: false, signal: new AbortController().signal }),
    ).rejects.toThrow("The edit history refresh did not complete.");
    expect(await screen.findByText("history refresh failed")).toBeTruthy();
  });

  it("debounces the live marked diff, relabels B, preserves its scroll, and collapses at the rail seam", async () => {
    const fixture = await createFixture();
    const rendered = renderWorkbench(fixture);
    const editor = await readyEditor();

    fireEvent.change(editor, { target: { value: "alpha\nlocal change\n" } });
    expect(screen.getByText("Updating candidate diff…")).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Unified diff" });
    expect(table.querySelector(".zhs-diff-mark")).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();

    const pane = table.closest<HTMLElement>(".zhs-diff-table-pane");
    if (pane === null) throw new Error("Diff pane was not rendered");
    pane.scrollTop = 73;
    fireEvent.scroll(pane);
    fireEvent.change(editor, { target: { value: "alpha\nanother local change\n" } });
    await screen.findByText("another local change");
    expect(pane.scrollTop).toBe(73);

    await userEvent.click(screen.getByRole("button", { name: "Use v1 as comparison B" }));
    await waitFor(() => expect(screen.getAllByText("vs v1").length).toBeGreaterThan(0));

    const body = rendered.container.querySelector(".zhs-edit-workbench__body");
    expect(body?.getAttribute("data-rail")).toBe("open");
    await userEvent.click(screen.getByRole("button", { name: "Collapse version history" }));
    expect(body?.getAttribute("data-rail")).toBe("closed");
    expect(screen.getByRole("button", { name: "Expand version history" })).toBeTruthy();
  });

  it("keeps a dirty draft until the explicit A-load confirmation is accepted", async () => {
    const fixture = await createFixture();
    renderWorkbench(fixture);
    const editor = await readyEditor();
    fireEvent.change(editor, { target: { value: "do not replace yet\n" } });

    await userEvent.click(screen.getByRole("button", { name: "Use v1 as source A" }));
    expect(await screen.findByText("Load v1 into the editor?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
    expect(editor.value).toBe("do not replace yet\n");

    await userEvent.click(screen.getByRole("button", { name: "Edit from v1" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load v1" }));
    await waitFor(() => expect(editor.value).toBe("alpha\nfirst\n"));
    expect(screen.getByText("Editing from v1")).toBeTruthy();
    expect(screen.getByText(/still saves on top of head v2/u)).toBeTruthy();
  });

  it("prevents intervening edits while an accepted A-load is delayed", async () => {
    const baseFixture = await createFixture();
    const delayed = delayVersionRead(baseFixture, 1);
    renderWorkbench(delayed.fixture);
    const editor = await readyEditor();
    fireEvent.change(editor, { target: { value: "confirmed draft\n" } });

    await userEvent.click(screen.getByRole("button", { name: "Use v1 as source A" }));
    await userEvent.click(await screen.findByRole("button", { name: "Load v1" }));
    await delayed.started;
    await waitFor(() => expect(editor.disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await userEvent.type(editor, "intervening edit");
    expect(editor.value).toBe("confirmed draft\n");
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).not.toContain(
      "intervening edit",
    );

    delayed.release();
    await waitFor(() => expect(editor.value).toBe("alpha\nfirst\n"));
    expect(editor.disabled).toBe(false);
  });

  it("uses one semantic pane under 56rem and describes why Split is disabled", async () => {
    mockNarrowViewport(true);
    const fixture = await createFixture();
    renderWorkbench(fixture);
    await readyEditor();

    const paneTabs = screen.getByRole("group", { name: "Pane" });
    expect(
      within(paneTabs).getByRole("button", { name: "Editor" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("region", { name: "Editor" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Live candidate diff" })).toBeNull();

    const split = screen.getByRole("button", { name: "Split" });
    expect((split as HTMLButtonElement).disabled).toBe(true);
    const descriptionId = split.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("wider than 56rem");

    await userEvent.click(within(paneTabs).getByRole("button", { name: "Diff" }));
    expect(screen.getByRole("region", { name: "Live candidate diff" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Editor" })).toBeNull();
  });

  it("opens with Ctrl+S, saves once against the head fence, refreshes the rail, and clears the draft", async () => {
    const fixture = await createFixture();
    const onSaved = vi.fn<(result: EditWorkbenchSaved) => void>();
    renderWorkbench(fixture, { onSaved });
    const editor = await readyEditor();
    fixture.requests.length = 0;
    fireEvent.change(editor, { target: { value: "alpha\nsaved locally\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Review save against head v2" });
    const save = within(dialog).getByRole("button", { name: "Save v3" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved.mock.calls[0]?.[0]).toMatchObject({
      completion: { state: "saved", version: 3 },
      record: { version: 3, body: "alpha\nsaved locally\n" },
    });
    expect(mutationRequests(fixture)).toHaveLength(1);
    const input = (await mutationRequests(fixture)[0]?.clone().json()) as {
      expectedVersion?: number;
    };
    expect(input.expectedVersion).toBe(2);
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === `/v1/stashes/${STASH}/history/${PATH}`,
      ),
    ).toHaveLength(1);
    expect(
      fixture.requests.filter((request) => {
        const url = new URL(request.url);
        return (
          request.method === "GET" &&
          url.pathname === `/v1/stashes/${STASH}/files/${PATH}` &&
          url.searchParams.get("version") === "3"
        );
      }),
    ).toHaveLength(1);
    expect(screen.getByText("History — 3 versions")).toBeTruthy();
    expect(screen.getByText(/Saved v3/u)).toBeTruthy();
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
  });

  it("threads Save as proposal through the workbench without moving the file head", async () => {
    const fixture = await createFixture();
    const onProposed = vi.fn<(record: ProposalRecord) => void>();
    renderWorkbench(fixture, { onProposed });
    const editor = await readyEditor();
    fireEvent.change(editor, { target: { value: "alpha\nproposed locally\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog", { name: "Review save against head v2" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Author" }), "Ada");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Message" }), "Please review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as proposal" }));

    await waitFor(() => expect(onProposed).toHaveBeenCalledTimes(1));
    const record = onProposed.mock.calls[0]?.[0];
    expect(record).toMatchObject({
      path: PATH,
      baseVersion: 2,
      author: "Ada",
      message: "Please review",
      status: "open",
    });
    if (record === undefined) throw new Error("Proposal callback was not delivered");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor.value).toBe("alpha\nproposed locally\n");
    const proposal = await fixture.client.proposals(STASH).get(record.id);
    expect(proposal.ok && proposal.value.body).toBe("alpha\nproposed locally\n");
    const history = await fixture.client.files(STASH).history(PATH);
    expect(history.ok && history.value.headVersion).toBe(2);
  });

  it("shows stale state, reloads the new head explicitly, and never starts a second put", async () => {
    const fixture = await createFixture();
    renderWorkbench(fixture);
    const editor = await readyEditor();
    fixture.requests.length = 0;
    fireEvent.change(editor, { target: { value: "alpha\nmy draft\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog");
    const message = within(dialog).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const author = within(dialog).getByRole("textbox", { name: "Author" }) as HTMLInputElement;
    await userEvent.type(message, "Typed local message");
    await userEvent.type(author, "Local author");
    await put(fixture.remoteClient, "alpha\nremote head\n", 2, "Remote", "Remote head message");
    const save = within(dialog).getByRole("button", { name: "Save v3" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(save);

    expect(await within(dialog).findByText("Head moved to v3 by Remote")).toBeTruthy();
    expect(mutationRequests(fixture)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload & compare" }));
    expect(await within(dialog).findByText("Remote head message")).toBeTruthy();
    expect(message.value).toBe("Typed local message");
    expect(author.value).toBe("Local author");
    expect(within(dialog).getByText(/Saves as v4 on top of v3/u)).toBeTruthy();
    expect(mutationRequests(fixture)).toHaveLength(1);
    expect(editor.value).toBe("alpha\nmy draft\n");
  });

  it("restores a persisted session draft without confusing source A with the head", async () => {
    const fixture = await createFixture();
    const first = renderWorkbench(fixture);
    const editor = await readyEditor();
    fireEvent.change(editor, { target: { value: "restored session draft\n" } });
    await waitFor(() =>
      expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toContain(
        "restored session draft",
      ),
    );
    first.unmount();

    renderWorkbench(fixture);
    const restored = await readyEditor();
    expect(restored.value).toBe("restored session draft\n");
    expect(screen.getByText(/Restored unsaved draft/u)).toBeTruthy();
    expect(screen.getByText("head v2")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(restored.value).toBe("alpha\nhead\n");
    expect(sessionStorage.getItem(workbenchDraftKey(STASH, PATH))).toBeNull();
  });

  it("keeps its leaf stylesheet namespaced, token-driven, and overflow-safe", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/edit-workbench.css"), "utf8");
    const selectors = [...css.matchAll(/\.(zhs-[a-zA-Z0-9_-]+)/gu)].map((match) => match[1]);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors.every((selector) => selector?.startsWith("zhs-"))).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}|\brgb\(|\boklch\(|:\s*transparent\b/iu);
    expect(css).not.toMatch(/\dpx\b/u);
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("@media (width > 56rem)");
    expect(css).toContain("min-inline-size: 0");
    expect(css).toContain("overflow: clip");
  });
});
