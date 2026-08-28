import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ClientResult,
  GetDiffResult,
  GetHistoryResult,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import DiffPage from "./diff.js";

const UNIFIED = [
  "Index: docs/readme.txt",
  "===================================================================",
  "--- a/docs/readme.txt@v2",
  "+++ b/docs/readme.txt@v3",
  "@@ -1,3 +1,3 @@",
  " alpha",
  "-old line",
  "+new line",
  " omega",
  "",
].join("\n");

function version(overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: 3,
    kind: "put",
    hash: "sha256-v3",
    size: 24,
    rollbackOf: null,
    author: "Ada",
    message: "Update notes",
    meta: {},
    createdAt: "2026-08-25T09:00:00.000Z",
    ...overrides,
  };
}

const HISTORY: GetHistoryResult = {
  path: "docs/readme.txt",
  headVersion: 3,
  deleted: false,
  total: 3,
  versions: [
    version(),
    version({
      version: 2,
      kind: "rollback",
      rollbackOf: 1,
      hash: "sha256-v1",
      createdAt: "2026-08-25T08:00:00.000Z",
    }),
    version({
      version: 1,
      hash: "sha256-v1",
      createdAt: "2026-08-25T07:00:00.000Z",
    }),
  ],
  nextBefore: null,
};

const READY: GetDiffResult = {
  state: "ready",
  unified: UNIFIED,
  truncated: false,
  stats: { added: 1, removed: 1 },
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [" alpha", "-old line", "+new line", " omega", "\\ No newline at end of file"],
    },
  ],
  from: { version: 2, hash: "sha256-v1", deleted: false },
  to: { version: 3, hash: "sha256-v3", deleted: false },
};

function createDiffClient(
  diffResult: ClientResult<GetDiffResult>,
  historyResult: ClientResult<GetHistoryResult> = { ok: true, value: HISTORY },
) {
  const defaults = createFakeViewerClient();
  const history = vi.fn(async (): Promise<ClientResult<GetHistoryResult>> => historyResult);
  const diff = vi.fn(async (): Promise<ClientResult<GetDiffResult>> => diffResult);
  const client = createFakeViewerClient({
    files: (stash) => ({
      ...defaults.files(stash),
      history,
      diff,
    }),
  });
  return { client, diff, history };
}

function createPendingDiffClient() {
  const defaults = createFakeViewerClient();
  const client = createFakeViewerClient({
    files: (stash) => ({
      ...defaults.files(stash),
      history: async () => ({ ok: true, value: HISTORY }),
      diff: vi.fn(
        () =>
          new Promise<ClientResult<GetDiffResult>>(() => {
            // Intentionally pending.
          }),
      ),
    }),
  });
  return client;
}

function renderDiffRoute(initialEntry: string, client: ViewerStashClient) {
  sessionStorage.setItem("zhs.token", "zhs_test");
  const clientFactory: ViewerStashClientFactory = () => client;
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <Outlet />
          </StashClientProvider>
        ),
        children: [
          { path: "/s/:stash/diff/*", element: <DiffPage /> },
          { path: "/login", element: <p>Login page</p> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function mockNarrowViewport(isNarrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(max-width: 56rem)" && isNarrow,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function cell(row: Element, column: string): HTMLElement {
  const value = row.querySelector<HTMLElement>(`[data-column="${column}"]`);
  if (!value) throw new Error(`Missing ${column} cell`);
  return value;
}

describe("DiffPage", () => {
  it("shows a loading state while the comparison is pending", () => {
    renderDiffRoute(
      "/s/notes/diff/docs/readme.txt?from=2&to=head&context=3",
      createPendingDiffClient(),
    );
    expect(screen.getByText("Loading comparison…")).toBeTruthy();
  });

  it("renders the same state with resolved versions", async () => {
    const same: GetDiffResult = {
      state: "same",
      from: { version: 2, hash: "sha256-shared", deleted: false },
      to: { version: 3, hash: "sha256-shared", deleted: false },
    };
    const { client } = createDiffClient({ ok: true, value: same });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=head", client);

    expect(
      await screen.findByRole("heading", { name: "No differences between v2 and v3" }),
    ).toBeTruthy();
    expect(screen.getByText("v2 → v3 (head)")).toBeTruthy();
  });

  it("renders structured hunks with correct gutters, signs, markers, and newest-first choices", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { client } = createDiffClient({ ok: true, value: READY });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=head&context=3", client);

    expect(await screen.findByRole("table", { name: "Unified diff" })).toBeTruthy();
    expect(screen.getByText("@@ -1,3 +1,3 @@")).toBeTruthy();
    const remove = document.querySelector('[data-line-type="remove"]');
    const add = document.querySelector('[data-line-type="add"]');
    const context = document.querySelector('[data-line-type="context"]');
    if (!remove || !add || !context) throw new Error("Expected add, remove, and context rows");
    expect(cell(remove, "old").textContent).toBe("2");
    expect(cell(remove, "new").textContent).toBe("");
    expect(cell(remove, "sign").textContent).toBe("−");
    expect(cell(add, "old").textContent).toBe("");
    expect(cell(add, "new").textContent).toBe("2");
    expect(cell(add, "sign").textContent).toBe("+");
    expect(cell(context, "sign").dataset.diffSign).toBe(" ");
    expect(screen.getByText("\\ No newline at end of file")).toBeTruthy();
    expect(screen.getByLabelText("1 lines added and 1 lines removed").textContent).toBe("+1−1");
    expect(screen.queryByText(/CRLF line endings/u)).toBeNull();
    expect(screen.queryByText(/Word-level marks were skipped/u)).toBeNull();

    const fromSelect = screen.getByLabelText("From version") as HTMLSelectElement;
    expect([...fromSelect.options].map((option) => option.text)).toEqual([
      "v3 · put",
      "v2 · rollback → v1",
      "v1 · put",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Copy unified" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(UNIFIED));
    expect(screen.getByText("Copied to clipboard.")).toBeTruthy();
  });

  it("renders oversized reasons and links both resolved raw versions", async () => {
    const oversized: GetDiffResult = {
      state: "oversized",
      reason: "bytes",
      from: { version: 1, hash: null, deleted: true },
      to: { version: 3, hash: "sha256-v3", deleted: false },
    };
    const { client } = createDiffClient({ ok: true, value: oversized });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=1&to=head", client);

    expect(await screen.findByText(/512 KiB per-side diff limit/u)).toBeTruthy();
    expect(screen.getByText("v1 (deleted) → v3 (head)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open v1 raw (deleted)" }).getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt?version=1",
    );
    expect(screen.getByRole("link", { name: "Open v3 raw" }).getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt?version=3",
    );
  });

  it("explains a comparison that exceeds the complexity limit", async () => {
    const oversized: GetDiffResult = {
      state: "oversized",
      reason: "complexity",
      from: { version: 2, hash: "sha256-v2", deleted: false },
      to: { version: 3, hash: "sha256-v3", deleted: false },
    };
    const { client } = createDiffClient({ ok: true, value: oversized });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    expect(await screen.findByText(/time or edit-complexity limit/u)).toBeTruthy();
  });

  it("shows a truncation notice above the complete structured table", async () => {
    const truncated: GetDiffResult = { ...READY, truncated: true, unified: "partial\n" };
    const { client } = createDiffClient({ ok: true, value: truncated });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    const notice = await screen.findByText("Unified output was truncated");
    const table = screen.getByRole("table", { name: "Unified diff" });
    expect(notice.closest("section")?.compareDocumentPosition(table)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByText("new line")).toBeTruthy();
  });

  it.each([
    {
      name: "old",
      lines: ["-old line\r", "+new line"],
      copy: "CRLF line endings on the old side are shown normalized",
    },
    {
      name: "new",
      lines: ["-old line", "+new line\r"],
      copy: "CRLF line endings on the new side are shown normalized",
    },
    {
      name: "both",
      lines: [" shared line\r"],
      copy: "CRLF line endings are shown normalized",
    },
  ])("shows the $name-side CRLF notice copy", async ({ lines, copy }) => {
    const withCrlf: GetDiffResult = {
      ...READY,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
    };
    const { client } = createDiffClient({ ok: true, value: withCrlf });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    expect(await screen.findByText(copy)).toBeTruthy();
  });

  it("reports when word-level marks are skipped for a long changed line", async () => {
    const prefix = "a".repeat(801);
    const withSkippedMarks: GetDiffResult = {
      ...READY,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [`-${prefix}x`, `+${prefix}y`],
        },
      ],
    };
    const { client } = createDiffClient({ ok: true, value: withSkippedMarks });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    expect(await screen.findByText("Word-level marks were skipped on 1 long line")).toBeTruthy();
  });

  it("persists view controls and renders split on a wide viewport without refetching", async () => {
    localStorage.setItem("zhs.diff.wrap", "false");
    mockNarrowViewport(false);
    const { client, diff } = createDiffClient({ ok: true, value: READY });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    const table = await screen.findByRole("table", { name: "Unified diff" });
    const pane = table.closest(".zhs-diff-table-pane");
    expect(pane?.className).toContain("zhs-diff-table-pane--nowrap");
    const requestCount = diff.mock.calls.length;
    const wrap = screen.getByRole("checkbox", { name: "Wrap" }) as HTMLInputElement;
    const marks = screen.getByRole("checkbox", { name: "Marks" }) as HTMLInputElement;
    expect(wrap.checked).toBe(false);
    expect(marks.checked).toBe(true);

    await userEvent.click(wrap);
    expect(pane?.className).toContain("zhs-diff-table-pane--wrap");
    expect(localStorage.getItem("zhs.diff.wrap")).toBe("true");

    await userEvent.click(marks);
    expect(pane?.className).toContain("zhs-diff-table-pane--no-marks");
    expect(localStorage.getItem("zhs.diff.marks")).toBe("false");

    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByRole("button", { name: "Split" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("zhs.diff.layout")).toBe("split");
    expect(screen.getByRole("table", { name: "Split diff" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Unified diff" })).toBeNull();
    expect(diff.mock.calls.length).toBe(requestCount);
  });

  it("keeps a stored split preference while forcing the effective narrow layout to unified", async () => {
    localStorage.setItem("zhs.diff.layout", "split");
    mockNarrowViewport(true);
    const { client } = createDiffClient({ ok: true, value: READY });
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    expect(await screen.findByRole("table", { name: "Unified diff" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Split diff" })).toBeNull();
    const split = screen.getByRole("button", { name: "Split" }) as HTMLButtonElement;
    expect(split.getAttribute("aria-pressed")).toBe("true");
    expect(split.disabled).toBe(true);
    expect(localStorage.getItem("zhs.diff.layout")).toBe("split");
  });

  it("updates comparison controls and resolves head before swapping", async () => {
    const { client, diff } = createDiffClient({ ok: true, value: READY });
    const { router } = renderDiffRoute(
      "/s/notes/diff/docs/readme.txt?from=2&to=head&context=3",
      client,
    );
    await screen.findByRole("table", { name: "Unified diff" });

    await userEvent.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() =>
      expect(diff).toHaveBeenLastCalledWith("docs/readme.txt", {
        from: 3,
        to: 2,
        context: 3,
      }),
    );
    expect(router.state.location.search).toContain("from=3");
    expect(router.state.location.search).toContain("to=2");

    await userEvent.selectOptions(screen.getByLabelText("Context lines"), "10");
    await waitFor(() =>
      expect(diff).toHaveBeenLastCalledWith("docs/readme.txt", {
        from: 3,
        to: 2,
        context: 10,
      }),
    );
  });

  it("shows non-auth request errors with a retry action", async () => {
    const failure: ClientResult<GetDiffResult> = {
      ok: false,
      error: { status: 503, code: "internal", message: "D1 unavailable" },
    };
    const { client, diff } = createDiffClient(failure);
    renderDiffRoute("/s/notes/diff/docs/readme.txt?from=2&to=3", client);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("D1 unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(diff).toHaveBeenCalledTimes(2));
  });

  it("preserves the full comparison deep link after a 401", async () => {
    const failure: ClientResult<GetDiffResult> = {
      ok: false,
      error: { status: 401, code: "unauthorized", message: "Expired" },
    };
    const { client } = createDiffClient(failure);
    const { router } = renderDiffRoute(
      "/s/notes/diff/docs/readme.txt?from=2&to=head&context=3",
      client,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe(
      "?next=%2Fs%2Fnotes%2Fdiff%2Fdocs%2Freadme.txt%3Ffrom%3D2%26to%3Dhead%26context%3D3",
    );
  });
});
