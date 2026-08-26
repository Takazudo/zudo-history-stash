import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StashHttpError,
  type ClientResult,
  type DiffHunk,
  type FileGetResult,
  type GetDiffResult,
  type RollbackResult,
  type StashFilesClient,
  type VersionRecord,
} from "@takazudo/zudo-history-stash";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { RollbackDialog, type RollbackSuccess } from "./rollback-dialog.js";

const READY_HUNKS: DiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 4,
    newStart: 1,
    newLines: 5,
    lines: [
      " context",
      "-old first",
      "-old second",
      "+new first",
      "+new second",
      "+new third",
      " tail",
    ],
  },
];

function targetVersion(overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: 2,
    kind: "put",
    hash: "sha256-target",
    size: 42,
    rollbackOf: null,
    author: "Ada",
    message: "Original content",
    meta: {},
    createdAt: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

function headResult(overrides: Record<string, unknown> = {}): FileGetResult {
  return {
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
      body: "current body",
      etag: '"v4-sha256-head"',
      ...overrides,
    },
  } as FileGetResult;
}

function readyDiff(from = 4, to = 2): ClientResult<GetDiffResult> {
  return {
    ok: true,
    value: {
      state: "ready",
      unified: "",
      truncated: false,
      hunks: READY_HUNKS,
      stats: { added: 3, removed: 2 },
      from: { version: from, hash: "sha256-head", deleted: false },
      to: { version: to, hash: "sha256-target", deleted: false },
    },
  };
}

function rollbackResult(): ClientResult<RollbackResult> {
  return {
    ok: true,
    value: {
      version: 5,
      hash: "sha256-target",
      rollbackOf: 2,
      identicalToHead: false,
      changeId: 9,
      createdAt: "2026-08-25T10:00:00.000Z",
    },
  };
}

function viewerClient(overrides: Partial<StashFilesClient> = {}): ViewerStashClient {
  const base = createFakeViewerClient();
  return createFakeViewerClient({
    files: (stash) => ({
      ...base.files(stash),
      get: async () => headResult(),
      diff: async (_path, options) =>
        readyDiff(options.from, typeof options.to === "number" ? options.to : 4),
      rollback: async () => rollbackResult(),
      ...overrides,
    }),
  });
}

function renderDialog({
  client = viewerClient(),
  target = targetVersion(),
  onClose = vi.fn(),
  onSuccess = vi.fn(),
}: {
  client?: ViewerStashClient;
  target?: VersionRecord;
  onClose?: () => void;
  onSuccess?: (success: RollbackSuccess) => void;
} = {}) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
  const clientFactory: ViewerStashClientFactory = () => client;
  return {
    onClose,
    onSuccess,
    ...render(
      <MemoryRouter>
        <StashClientProvider clientFactory={clientFactory}>
          <RollbackDialog
            client={client}
            path="docs/readme.txt"
            stash="notes"
            target={target}
            onClose={onClose}
            onSuccess={onSuccess}
          />
        </StashClientProvider>
      </MemoryRouter>,
    ),
  };
}

describe("RollbackDialog", () => {
  it("re-reads head, previews head-to-target stats, and submits the default message", async () => {
    const get = vi.fn(async () => headResult());
    const diff = vi.fn(async (_path, options) => readyDiff(options.from, options.to as number));
    const rollback = vi.fn(async () => rollbackResult());
    const onSuccess = vi.fn();
    renderDialog({ client: viewerClient({ get, diff, rollback }), onSuccess });

    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => {
      expect(confirm.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).toBe(confirm);
    });
    expect(screen.getByLabelText("3 lines added, 2 lines removed").textContent).toBe("+3 −2");
    const preview = screen.getByRole("region", { name: "Rollback diff preview" });
    expect(preview.classList.contains("zhs-rollback-dialog__preview")).toBe(true);
    expect(preview.hasAttribute("style")).toBe(false);
    const diffTable = within(preview).getByRole("table", { name: "Unified diff" });
    expect(diffTable.parentElement?.getAttribute("data-wrap")).toBe("on");
    expect(diffTable.querySelector(".zhs-diff-mark--removed")).toBeTruthy();
    expect(diffTable.querySelector(".zhs-diff-mark--added")).toBeTruthy();
    expect(within(diffTable).getAllByLabelText("Removed line")).toHaveLength(2);
    expect(within(diffTable).getAllByLabelText("Added line")).toHaveLength(3);
    expect(preview.querySelector("button, select, input")).toBeNull();
    expect(
      screen.getByText("This creates v5 as a rollback to v2. History is not deleted."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full diff" }).getAttribute("href")).toBe(
      "/s/notes/diff/docs/readme.txt?from=4&to=2",
    );

    await userEvent.click(confirm);

    expect(get).toHaveBeenCalledWith("docs/readme.txt");
    expect(diff).toHaveBeenCalledWith("docs/readme.txt", { from: 4, to: 2 });
    expect(rollback).toHaveBeenCalledWith(
      "docs/readme.txt",
      {
        toVersion: 2,
        expectedVersion: 4,
        author: "viewer",
        message: "Rollback to v2",
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(onSuccess).toHaveBeenCalledWith({
      result: expect.objectContaining({ version: 5, rollbackOf: 2 }),
      message: "Rollback to v2",
    });
  });

  it("shows a stale head with a reload action and never auto-rebases or retries", async () => {
    const get = vi
      .fn<StashFilesClient["get"]>()
      .mockResolvedValueOnce(headResult())
      .mockResolvedValueOnce(headResult({ version: 6, author: "Lin", hash: "sha256-new-head" }));
    const diff = vi.fn(async (_path, options) => readyDiff(options.from, options.to as number));
    const rollback = vi.fn<StashFilesClient["rollback"]>().mockResolvedValue({
      ok: false,
      error: { status: 409, code: "stale", message: "Head changed" },
      current: {
        version: 6,
        hash: "sha256-new-head",
        deleted: false,
        kind: "put",
        author: "Lin",
        createdAt: "2026-08-25T10:01:00.000Z",
      },
    });
    renderDialog({ client: viewerClient({ get, diff, rollback }) });

    await userEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));
    const stale = await screen.findByRole("alert");
    expect(stale.textContent).toContain("Head moved to v6 by Lin — reload to continue.");
    expect(rollback).toHaveBeenCalledTimes(1);

    await userEvent.click(within(stale).getByRole("button", { name: "Reload" }));
    expect(
      await screen.findByText("This creates v7 as a rollback to v2. History is not deleted."),
    ).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    expect(diff).toHaveBeenLastCalledWith("docs/readme.txt", { from: 6, to: 2 });
    expect(rollback).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(2));
    expect(rollback.mock.calls[1]?.[2]?.idempotencyKey).not.toBe(
      rollback.mock.calls[0]?.[2]?.idempotencyKey,
    );
  });

  it("warns when the target is byte-identical to the current head", async () => {
    renderDialog({
      client: viewerClient({
        get: async () => headResult({ hash: "sha256-target" }),
        diff: async () => ({
          ok: true,
          value: {
            state: "same",
            from: { version: 4, hash: "sha256-target", deleted: false },
            to: { version: 2, hash: "sha256-target", deleted: false },
          },
        }),
      }),
    });

    expect(
      await screen.findByText(
        "v2 is identical to the current head; a rollback still records a history item.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("0 lines added, 0 lines removed").textContent).toBe("+0 −0");
    expect(screen.queryByRole("table", { name: "Unified diff" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm rollback" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps summary stats and shows the exact notice when the diff is oversized", async () => {
    renderDialog({
      client: viewerClient({
        diff: async () => ({
          ok: true,
          value: {
            state: "oversized",
            reason: "bytes",
            from: { version: 4, hash: "sha256-head", deleted: false },
            to: { version: 2, hash: "sha256-target", deleted: false },
          },
        }),
      }),
    });

    expect(await screen.findByText("Preview unavailable: diff too large")).toBeTruthy();
    expect(screen.getByText("Head v4 → target v2")).toBeTruthy();
    expect(screen.getByText("Diff preview unavailable (bytes)")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Unified diff" })).toBeNull();
  });

  it("disables rollback when the target is a tombstone", async () => {
    const rollback = vi.fn(async () => rollbackResult());
    renderDialog({
      client: viewerClient({ rollback }),
      target: targetVersion({ kind: "delete", hash: null, size: 0 }),
    });

    expect(
      await screen.findByText("Rollback to a deletion is not allowed — use delete instead."),
    ).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm rollback" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await userEvent.click(confirm);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("renders network failures through ErrorBanner", async () => {
    const rollback = vi.fn(async () => {
      throw new StashHttpError(0, undefined, undefined, new Error("Network offline"));
    });
    renderDialog({ client: viewerClient({ rollback }) });

    await userEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not complete the rollback");
    expect(alert.textContent).toContain("Network offline");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reuses one Idempotency-Key across a failed submit and retry", async () => {
    const rollback = vi
      .fn<StashFilesClient["rollback"]>()
      .mockRejectedValueOnce(
        new StashHttpError(0, undefined, undefined, new Error("Connection dropped")),
      )
      .mockResolvedValueOnce(rollbackResult());
    const onSuccess = vi.fn();
    renderDialog({ client: viewerClient({ rollback }), onSuccess });

    await userEvent.click(await screen.findByRole("button", { name: "Confirm rollback" }));
    await userEvent.click(
      within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    expect(rollback).toHaveBeenCalledTimes(2);
    const firstOptions = rollback.mock.calls[0]?.[2];
    const secondOptions = rollback.mock.calls[1]?.[2];
    expect(firstOptions?.idempotencyKey).toBeTruthy();
    expect(secondOptions?.idempotencyKey).toBe(firstOptions?.idempotencyKey);
    expect(rollback.mock.calls[1]?.[1]).toBe(rollback.mock.calls[0]?.[1]);
    expect(rollback.mock.calls[1]?.[2]).toBe(rollback.mock.calls[0]?.[2]);
    expect(Object.isFrozen(rollback.mock.calls[0]?.[1])).toBe(true);
    expect(Object.isFrozen(rollback.mock.calls[0]?.[2])).toBe(true);
  });

  it("routes the native Escape cancellation only through onClose", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the package native dialog and focuses the safe confirm action when ready", async () => {
    renderDialog();
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    expect(screen.getByRole("dialog").tagName).toBe("DIALOG");
  });
});
