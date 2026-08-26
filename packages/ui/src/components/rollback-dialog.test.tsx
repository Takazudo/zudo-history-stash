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

async function seededClient(): Promise<{ client: StashClient; target: VersionRecord }> {
  const adminToken = globalThis.crypto.randomUUID();
  const fake = createFakeStash({ adminToken });
  fake.createStash(stash);
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    fetch: fake.fetch,
  });
  const files = client.files(stash);
  await files.put(path, {
    body: "target\n",
    expectedVersion: null,
    author: "Ada",
    message: "target",
  });
  await files.put(path, {
    body: "head\n",
    expectedVersion: 1,
    author: "Grace",
    message: "head",
  });
  const history = await files.history(path);
  if (!history.ok) throw new Error(history.error.message);
  const target = history.value.versions.find((item) => item.version === 1);
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

  it("routes native Escape cancellation only to onClose", async () => {
    const { client, target } = await seededClient();
    const onClose = vi.fn();
    renderDialog(client, target, vi.fn(), onClose);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
