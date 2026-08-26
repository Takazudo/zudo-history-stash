import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ClientResult,
  FileGetResult,
  GetDiffResult,
  HistoryPage,
  RollbackResult,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { HistoryList } from "./history-list.js";

function version(overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: 4,
    kind: "put",
    hash: "sha256-head",
    size: 64,
    rollbackOf: null,
    author: "Grace",
    message: "Current head",
    meta: {},
    createdAt: "2026-08-25T09:00:00.000Z",
    ...overrides,
  };
}

const history: HistoryPage = {
  path: "docs/readme.txt",
  headVersion: 4,
  deleted: false,
  total: 4,
  versions: [version(), version({ version: 2, hash: "sha256-target", size: 42 })],
  nextBefore: null,
};

function fakeClient(rollback: StashFilesClient["rollback"]): ViewerStashClient {
  const base = createFakeViewerClient();
  return createFakeViewerClient({
    files: (stash) => ({
      ...base.files(stash),
      get: async (): Promise<FileGetResult> => ({
        ok: true,
        value: {
          path: "docs/readme.txt",
          version: 4,
          hash: "sha256-head",
          size: 64,
          kind: "put",
          author: "Grace",
          message: "Current head",
          meta: {},
          createdAt: "2026-08-25T09:00:00.000Z",
          deleted: false,
          body: "head",
          etag: '"v4-sha256-head"',
        },
      }),
      diff: async (): Promise<ClientResult<GetDiffResult>> => ({
        ok: true,
        value: {
          state: "ready",
          unified: "",
          truncated: false,
          hunks: [],
          stats: { added: 1, removed: 2 },
          from: { version: 4, hash: "sha256-head", deleted: false },
          to: { version: 2, hash: "sha256-target", deleted: false },
        },
      }),
      rollback,
    }),
  });
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

describe("HistoryList rollback integration", () => {
  it("opens from an enabled history action, navigates, toasts, and grows history on success", async () => {
    const rollback = vi.fn(async (): Promise<ClientResult<RollbackResult>> => ({
      ok: true,
      value: {
        version: 5,
        hash: "sha256-target",
        rollbackOf: 2,
        identicalToHead: false,
        changeId: 9,
        createdAt: "2026-08-25T10:00:00.000Z",
      },
    }));
    const client = fakeClient(rollback);
    const clientFactory: ViewerStashClientFactory = () => client;
    const onRollbackComplete = vi.fn();
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
    render(
      <MemoryRouter initialEntries={["/s/notes/f/docs/readme.txt?version=2"]}>
        <StashClientProvider clientFactory={clientFactory}>
          <HistoryList
            client={client}
            onRollbackComplete={onRollbackComplete}
            page={history}
            path="docs/readme.txt"
            stash="notes"
            viewedVersion={2}
          />
          <LocationProbe />
        </StashClientProvider>
      </MemoryRouter>,
    );

    const targetRow = document.querySelector('[data-history-version="2"]');
    expect(targetRow).toBeTruthy();
    const rollbackButton = within(targetRow as HTMLElement).getByRole("button", {
      name: "Rollback to v2",
    });
    await waitFor(() => {
      expect(rollbackButton.hasAttribute("disabled")).toBe(false);
      expect(rollbackButton.getAttribute("title")).toBeNull();
    });

    await userEvent.click(rollbackButton);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));

    expect(
      await screen.findByText("Rollback complete. Created v5 as rollback to v2."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText("Current location").textContent).toBe(
        "/s/notes/f/docs/readme.txt",
      ),
    );
    expect(screen.getByText("5 versions, newest first.")).toBeTruthy();
    const createdRow = document.querySelector('[data-history-version="5"]');
    expect(createdRow).toBeTruthy();
    expect(within(createdRow as HTMLElement).getByText("rollback")).toBeTruthy();
    expect(within(createdRow as HTMLElement).getByText("→ v2")).toBeTruthy();
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
    expect(onRollbackComplete).toHaveBeenCalledOnce();
  });

  it("closes on Escape and restores focus to the history action", async () => {
    const rollback = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: 5,
        hash: "sha256-target",
        rollbackOf: 2,
        identicalToHead: false,
        changeId: 9,
        createdAt: "2026-08-25T10:00:00.000Z",
      },
    }));
    const client = fakeClient(rollback);
    render(
      <MemoryRouter>
        <HistoryList client={client} page={history} path="docs/readme.txt" stash="notes" />
      </MemoryRouter>,
    );

    const rollbackButton = screen.getByRole("button", { name: "Rollback to v2" });
    await waitFor(() => expect(rollbackButton.hasAttribute("disabled")).toBe(false));
    await userEvent.click(rollbackButton);
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(rollbackButton);
    expect(rollback).not.toHaveBeenCalled();
  });
});
