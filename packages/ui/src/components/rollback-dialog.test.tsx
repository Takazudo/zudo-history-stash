import {
  StashHttpError,
  createStashClient,
  type ClientResult,
  type MeResponse,
  type RollbackResult,
  type StashClient,
  type StashFilesClient,
  type VersionRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { RollbackDialog, type RollbackSuccess } from "./rollback-dialog.js";

const stash = "notes";
const path = "docs/readme.txt";

function successResult(version = 3): ClientResult<RollbackResult> {
  return {
    ok: true,
    value: {
      version,
      hash: "sha256-target",
      rollbackOf: 1,
      identicalToHead: false,
      changeId: version,
      createdAt: "2026-08-25T10:00:00.000Z",
    },
  };
}

async function seededClient(
  stashName = stash,
  pathName = path,
  targetVersion = 1,
): Promise<{ client: StashClient; target: VersionRecord }> {
  const adminToken = globalThis.crypto.randomUUID();
  const fake = createFakeStash({ adminToken });
  fake.createStash(stashName);
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    fetch: fake.fetch,
  });
  const files = client.files(stashName);
  await files.put(pathName, {
    body: "target\n",
    expectedVersion: null,
    author: "Ada",
    message: "target",
  });
  await files.put(pathName, {
    body: "head\n",
    expectedVersion: 1,
    author: "Grace",
    message: "head",
  });
  const history = await files.history(pathName);
  if (!history.ok) throw new Error(history.error.message);
  const target = history.value.versions.find((item) => item.version === targetVersion);
  if (!target) throw new Error("Missing target fixture");
  return { client, target };
}

function renderDialog(
  client: StashClient,
  target: VersionRecord,
  onSuccess: (success: RollbackSuccess) => void = vi.fn(),
  onClose: () => void = vi.fn(),
) {
  return render(
    <StashUiProvider client={client}>
      <RollbackDialog
        path={path}
        stash={stash}
        target={target}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </StashUiProvider>,
  );
}

function ControlledRollbackDialog({
  client,
  target,
  onClose,
  onSuccess,
}: {
  client: StashClient;
  target: VersionRecord;
  onClose: () => void;
  onSuccess: (success: RollbackSuccess) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <StashUiProvider client={client}>
      {open ? (
        <RollbackDialog
          path={path}
          stash={stash}
          target={target}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onSuccess={(success) => {
            onSuccess(success);
            setOpen(false);
          }}
        />
      ) : null}
    </StashUiProvider>
  );
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function attemptDialogClose(): void {
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  fireEvent.click(screen.getByRole("button", { name: "Close rollback dialog" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
}

describe("package RollbackDialog", () => {
  it("uses the fake backend for preview and append-only rollback through package primitives", async () => {
    const { client, target } = await seededClient();
    const onSuccess = vi.fn();
    renderDialog(client, target, onSuccess);

    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("dialog").tagName).toBe("DIALOG");
    expect(screen.getByRole("table", { name: "Unified diff" })).toBeTruthy();
    await userEvent.click(confirm);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    const history = await client.files(stash).history(path);
    expect(history.ok && history.value.versions[0]).toMatchObject({
      version: 3,
      kind: "rollback",
      rollbackOf: 1,
    });
  });

  it("waits for useCanWrite readiness before any mutation, including form-submit bypasses", async () => {
    const { client, target } = await seededClient();
    let resolveMe!: (result: ClientResult<MeResponse>) => void;
    const meRequest = new Promise<ClientResult<MeResponse>>((resolve) => {
      resolveMe = resolve;
    });
    vi.spyOn(client, "me").mockReturnValue(meRequest);
    const files = client.files(stash);
    const rollback = vi.fn<StashFilesClient["rollback"]>().mockResolvedValue(successResult());
    vi.spyOn(client, "files").mockImplementation(() => ({ ...files, rollback }));
    renderDialog(client, target);

    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.submit(confirm.closest("form") as HTMLFormElement);
    expect(rollback).not.toHaveBeenCalled();

    await act(async () => resolveMe({ ok: true, value: { principal: "admin" } }));
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await userEvent.click(confirm);
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(1));
  });

  it("replays the exact frozen body and key only for an explicit transport retry", async () => {
    const { client, target } = await seededClient();
    const files = client.files(stash);
    const rollback = vi
      .fn<StashFilesClient["rollback"]>()
      .mockRejectedValueOnce(
        new StashHttpError(0, undefined, undefined, new Error("Connection dropped")),
      )
      .mockResolvedValueOnce(successResult());
    vi.spyOn(client, "files").mockImplementation(() => ({ ...files, rollback }));
    const onSuccess = vi.fn();
    renderDialog(client, target, onSuccess);

    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await userEvent.click(confirm);
    const retry = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    expect(
      screen.getByRole("textbox", { name: "Message (optional)" }).hasAttribute("disabled"),
    ).toBe(true);
    await userEvent.click(retry);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));

    expect(rollback.mock.calls[1]?.[1]).toBe(rollback.mock.calls[0]?.[1]);
    expect(rollback.mock.calls[1]?.[2]).toBe(rollback.mock.calls[0]?.[2]);
    expect(Object.isFrozen(rollback.mock.calls[0]?.[1])).toBe(true);
    expect(Object.isFrozen(rollback.mock.calls[0]?.[2])).toBe(true);
  });

  it("invalidates a stale attempt, does not auto-retry, and mints a new key after reload", async () => {
    const { client, target } = await seededClient();
    const files = client.files(stash);
    const rollback = vi
      .fn<StashFilesClient["rollback"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { status: 409, code: "stale", message: "Head changed" },
        current: {
          version: 3,
          hash: "sha256-new",
          deleted: false,
          kind: "put",
          author: "Lin",
          createdAt: "2026-08-25T10:01:00.000Z",
        },
      })
      .mockResolvedValueOnce(successResult());
    vi.spyOn(client, "files").mockImplementation(() => ({ ...files, rollback }));
    renderDialog(client, target);

    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await userEvent.click(confirm);
    const stale = await screen.findByRole("alert");
    expect(rollback).toHaveBeenCalledTimes(1);
    await userEvent.click(within(stale).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText("Head changed")).toBeNull());
    const refreshedConfirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(refreshedConfirm.hasAttribute("disabled")).toBe(false));
    await userEvent.click(refreshedConfirm);
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(2));
    expect(rollback.mock.calls[1]?.[2]?.idempotencyKey).not.toBe(
      rollback.mock.calls[0]?.[2]?.idempotencyKey,
    );
  });

  it.each(["success", "transport failure"] as const)(
    "ignores a deferred %s from an old client and target lifecycle",
    async (outcome) => {
      const original = await seededClient();
      const nextStash = "archive";
      const nextPath = "other.txt";
      const next = await seededClient(nextStash, nextPath, 2);
      let resolveCurrent!: (result: ClientResult<RollbackResult>) => void;
      const currentRequest = new Promise<ClientResult<RollbackResult>>((resolve) => {
        resolveCurrent = resolve;
      });
      const nextFiles = next.client.files(nextStash);
      const nextRollback = vi.fn<StashFilesClient["rollback"]>().mockReturnValue(currentRequest);
      vi.spyOn(next.client, "files").mockImplementation(() => ({
        ...nextFiles,
        rollback: nextRollback,
      }));
      let settleOld!: () => void;
      const oldRequest = new Promise<ClientResult<RollbackResult>>((resolve, reject) => {
        settleOld =
          outcome === "success"
            ? () => resolve(successResult())
            : () => reject(new Error("old transport failed"));
      });
      const originalFiles = original.client.files(stash);
      const rollback = vi.fn<StashFilesClient["rollback"]>().mockReturnValue(oldRequest);
      vi.spyOn(original.client, "files").mockImplementation(() => ({
        ...originalFiles,
        rollback,
      }));
      const onSuccess = vi.fn();
      const rendered = renderDialog(original.client, original.target, onSuccess);

      const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
      await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
      const message = screen.getByRole("textbox", { name: "Message (optional)" });
      await userEvent.clear(message);
      await userEvent.type(message, "old target message");
      await userEvent.click(confirm);
      expect(rollback).toHaveBeenCalledOnce();

      rendered.rerender(
        <StashUiProvider client={next.client}>
          <RollbackDialog
            path={nextPath}
            stash={nextStash}
            target={next.target}
            onClose={vi.fn()}
            onSuccess={onSuccess}
          />
        </StashUiProvider>,
      );

      const nextMessage = await screen.findByRole("textbox", { name: "Message (optional)" });
      expect((nextMessage as HTMLTextAreaElement).value).toBe("Rollback to v2");
      const nextConfirm = screen.getByRole("button", { name: "Confirm rollback" });
      await waitFor(() => expect(nextConfirm.hasAttribute("disabled")).toBe(false));
      await userEvent.click(nextConfirm);
      expect(nextRollback).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Rolling back…" })).toBeTruthy();

      await act(async () => settleOld());
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.queryByText("old transport failed")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("button", { name: "Rolling back…" }).hasAttribute("disabled")).toBe(
        true,
      );

      await act(async () => resolveCurrent(successResult(4)));
      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({ version: 4 }),
          message: "Rollback to v2",
        }),
      );
    },
  );

  it("blocks every close surface while rollback is pending and reports one success", async () => {
    const { client, target } = await seededClient();
    const request = deferred<ClientResult<RollbackResult>>();
    const files = client.files(stash);
    const rollback = vi.fn<StashFilesClient["rollback"]>(() => {
      attemptDialogClose();
      return request.promise;
    });
    vi.spyOn(client, "files").mockImplementation(() => ({ ...files, rollback }));
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(
      <ControlledRollbackDialog
        client={client}
        target={target}
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.submit(confirm.closest("form") as HTMLFormElement);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      within(dialog)
        .getByRole("button", { name: "Close rollback dialog" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog);

    await act(async () => request.resolve(successResult()));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ version: 3, rollbackOf: 1 }),
        message: "Rollback to v1",
      }),
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("routes native Escape cancellation and header Close only to onClose while idle", async () => {
    const { client, target } = await seededClient();
    const onClose = vi.fn();
    renderDialog(client, target, vi.fn(), onClose);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close rollback dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
