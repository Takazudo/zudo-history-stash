import { createStashClient, type StashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { DeleteFileDialog, type DeleteFileDialogProps } from "./delete-file-dialog.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const OTHER_PATH = "docs/other.txt";
const BASE_URL = "https://delete-dialog.test";

interface RecordedDelete {
  path: string;
  bodyText: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

interface Fixture {
  fake: FakeStash;
  fetch: ReturnType<typeof vi.fn<StashFetch>>;
  client: StashClient;
  deletes: RecordedDelete[];
  deferNextDelete: () => () => void;
  loseNextDeleteResponse: () => void;
}

async function makeFixture(paths: readonly string[] = [PATH]): Promise<Fixture> {
  const adminToken = "delete-dialog-admin";
  const fake = createFakeStash({ adminToken });
  fake.createStash(STASH);
  const deletes: RecordedDelete[] = [];
  let deleteGate: Promise<void> | null = null;
  let loseResponses = 0;

  const fetch = vi.fn<StashFetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isDelete = request.method === "POST" && url.pathname.includes("/delete/");
    if (isDelete) {
      const bodyText = await request.clone().text();
      deletes.push({
        path: decodeURIComponent(url.pathname.split("/delete/")[1] ?? ""),
        bodyText,
        body: JSON.parse(bodyText) as Record<string, unknown>,
        idempotencyKey: request.headers.get("Idempotency-Key"),
      });
      if (deleteGate !== null) {
        const gate = deleteGate;
        deleteGate = null;
        await gate;
      }
    }

    const response = await fake.fetch(input, init);
    if (isDelete && loseResponses > 0) {
      loseResponses -= 1;
      throw new TypeError("response lost");
    }
    return response;
  });
  const client = createStashClient({
    baseUrl: BASE_URL,
    token: adminToken,
    fetch,
    idempotencyKey: () => {
      throw new Error("DeleteFileDialog must supply its canonical key");
    },
  });

  for (const [index, path] of paths.entries()) {
    const result = await client.files(STASH).put(
      path,
      {
        body: `body ${index + 1}\n`,
        expectedVersion: null,
        author: "fixture",
        message: "seed",
      },
      { idempotencyKey: `fixture-seed-${index + 1}` },
    );
    if (!result.ok) throw new Error(result.error.message);
  }
  deletes.length = 0;
  fetch.mockClear();

  return {
    fake,
    fetch,
    client,
    deletes,
    deferNextDelete() {
      let release: () => void = () => {};
      deleteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    loseNextDeleteResponse() {
      loseResponses += 1;
    },
  };
}

function renderDelete(fixture: Fixture, overrides: Partial<DeleteFileDialogProps> = {}) {
  const props: DeleteFileDialogProps = {
    open: true,
    stash: STASH,
    path: PATH,
    headVersion: 1,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <StashUiProvider client={fixture.client}>
        <DeleteFileDialog {...props} />
      </StashUiProvider>,
    ),
  };
}

function DeleteHost({ fixture, props }: { fixture: Fixture; props: DeleteFileDialogProps }) {
  return (
    <StashUiProvider client={fixture.client}>
      <DeleteFileDialog {...props} />
    </StashUiProvider>
  );
}

describe("DeleteFileDialog", () => {
  it("deletes through the fake with the supplied CAS fence and one minted key", async () => {
    const fixture = await makeFixture();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    renderDelete(fixture, { onClose, onChanged });
    const user = userEvent.setup();

    const dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    expect(dialog.className).toContain("zhs-delete-file-dialog");
    expect(dialog.textContent).toContain(
      "Creates v2 as a tombstone · history is never deleted · restore later with rollback",
    );
    await user.type(within(dialog).getByRole("textbox", { name: /Author/ }), "Ada");
    await user.type(within(dialog).getByRole("textbox", { name: /Message/ }), "Remove old file");
    await user.click(within(dialog).getByRole("button", { name: "Delete as v2" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fixture.deletes).toHaveLength(1);
    expect(fixture.deletes[0]).toMatchObject({
      path: PATH,
      body: { expectedVersion: 1, author: "Ada", message: "Remove old file" },
    });
    expect(fixture.deletes[0]?.idempotencyKey).toBeTruthy();

    const history = await fixture.client.files(STASH).history(PATH);
    expect(history.ok && history.value.versions[0]).toMatchObject({ version: 2, kind: "delete" });
  });

  it("keeps Cancel and Escape atomic while one delete is pending and reports once", async () => {
    const fixture = await makeFixture();
    const releaseDelete = fixture.deferNextDelete();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    renderDelete(fixture, { onClose, onChanged });
    const dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    const form = dialog.querySelector("form")!;

    fireEvent.submit(form);
    await waitFor(() => expect(fixture.deletes).toHaveLength(1));
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(fixture.deletes).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(dialog.hasAttribute("open")).toBe(true);

    await act(async () => releaseDelete());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fixture.deletes).toHaveLength(1);
  });

  it("replays the exact frozen body and key after a lost transport response", async () => {
    const fixture = await makeFixture();
    fixture.loseNextDeleteResponse();
    const onChanged = vi.fn();
    renderDelete(fixture, { onChanged });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    await user.type(within(dialog).getByRole("textbox", { name: /Author/ }), "Grace");
    await user.type(within(dialog).getByRole("textbox", { name: /Message/ }), "Archive this");
    await user.click(within(dialog).getByRole("button", { name: "Delete as v2" }));

    const retry = within(await screen.findByRole("alert")).getByRole("button", {
      name: "Try again",
    });
    expect(
      within(dialog)
        .getByRole("textbox", { name: /Author/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(retry);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    expect(fixture.deletes).toHaveLength(2);
    expect(fixture.deletes[1]?.bodyText).toBe(fixture.deletes[0]?.bodyText);
    expect(fixture.deletes[1]?.idempotencyKey).toBe(fixture.deletes[0]?.idempotencyKey);
    expect(fixture.deletes[0]?.idempotencyKey).toBeTruthy();
  });

  it("keeps metadata on close but mints a new operation key after reopening", async () => {
    const fixture = await makeFixture();
    fixture.loseNextDeleteResponse();
    const onClose = vi.fn();
    const props: DeleteFileDialogProps = {
      open: true,
      stash: STASH,
      path: PATH,
      headVersion: 1,
      onClose,
      onChanged: vi.fn(),
    };
    const view = render(<DeleteHost fixture={fixture} props={props} />);
    const user = userEvent.setup();
    let dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    const author = within(dialog).getByRole("textbox", { name: /Author/ });
    await user.type(author, "Kept author");
    await user.click(within(dialog).getByRole("button", { name: "Delete as v2" }));
    await screen.findByRole("alert");
    const firstKey = fixture.deletes[0]?.idempotencyKey;

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<DeleteHost fixture={fixture} props={{ ...props, open: false }} />);
    view.rerender(<DeleteHost fixture={fixture} props={props} />);
    dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    expect(
      (within(dialog).getByRole("textbox", { name: /Author/ }) as HTMLInputElement).value,
    ).toBe("Kept author");
    await user.click(within(dialog).getByRole("button", { name: "Delete as v2" }));
    await screen.findByText("Head moved to v2 — reload");

    expect(fixture.deletes).toHaveLength(2);
    expect(fixture.deletes[1]?.idempotencyKey).toBeTruthy();
    expect(fixture.deletes[1]?.idempotencyKey).not.toBe(firstKey);
  });

  it("shows the authoritative moved head and never retries a stale delete", async () => {
    const fixture = await makeFixture();
    const remote = await fixture.client.files(STASH).put(
      PATH,
      {
        body: "new head\n",
        expectedVersion: 1,
        author: "Lin",
        message: "Concurrent edit",
      },
      { idempotencyKey: "fixture-remote" },
    );
    if (!remote.ok) throw new Error(remote.error.message);
    renderDelete(fixture, { headVersion: 1 });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    await user.click(within(dialog).getByRole("button", { name: "Delete as v2" }));

    expect(await screen.findByText("Head moved to v2 — reload")).toBeTruthy();
    expect(dialog.textContent).toContain("The stale delete was not retried.");
    fireEvent.submit(dialog.querySelector("form")!);
    expect(fixture.deletes).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /Try again|Retry/ })).toBeNull();
  });

  it("treats an already-deleted matching head as changed and closes exactly once", async () => {
    const fixture = await makeFixture();
    const deleted = await fixture.client
      .files(STASH)
      .delete(
        PATH,
        { expectedVersion: 1, author: "fixture" },
        { idempotencyKey: "fixture-delete" },
      );
    if (!deleted.ok) throw new Error(deleted.error.message);
    fixture.deletes.length = 0;
    const onClose = vi.fn();
    const onChanged = vi.fn();
    renderDelete(fixture, { headVersion: 2, onClose, onChanged });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete as v3" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fixture.deletes).toHaveLength(1);
    expect(fixture.deletes[0]?.body.expectedVersion).toBe(2);
  });

  it("invalidates an old pending target and never lets its result close the new dialog", async () => {
    const fixture = await makeFixture([PATH, OTHER_PATH]);
    const releaseOldDelete = fixture.deferNextDelete();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    const firstProps: DeleteFileDialogProps = {
      open: true,
      stash: STASH,
      path: PATH,
      headVersion: 1,
      onClose,
      onChanged,
    };
    const view = render(<DeleteHost fixture={fixture} props={firstProps} />);
    const firstDialog = await screen.findByRole("dialog", { name: `Delete ${PATH}` });
    fireEvent.submit(firstDialog.querySelector("form")!);
    await waitFor(() => expect(fixture.deletes).toHaveLength(1));

    view.rerender(<DeleteHost fixture={fixture} props={{ ...firstProps, path: OTHER_PATH }} />);
    const nextDialog = await screen.findByRole("dialog", { name: `Delete ${OTHER_PATH}` });
    expect(nextDialog).not.toBe(firstDialog);
    await act(async () => releaseOldDelete());
    await waitFor(async () => {
      const history = await fixture.client.files(STASH).history(PATH);
      expect(history.ok && history.value.headVersion).toBe(2);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: `Delete ${OTHER_PATH}` })).toBe(nextDialog);

    await userEvent.click(within(nextDialog).getByRole("button", { name: "Delete as v2" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fixture.deletes.map((entry) => entry.path)).toEqual([PATH, OTHER_PATH]);
  });

  it("renders no surface and makes no data or mutation call for a read principal", async () => {
    const adminToken = "delete-denied-admin";
    const fake = createFakeStash({ adminToken });
    fake.createStash(STASH);
    const readToken = await fake.mintToken(STASH, "read");
    const fetch = vi.fn<StashFetch>(fake.fetch);
    const client = createStashClient({ baseUrl: BASE_URL, token: readToken, fetch });
    const onChanged = vi.fn();
    render(
      <StashUiProvider client={client}>
        <DeleteFileDialog
          headVersion={1}
          open={true}
          path={PATH}
          stash={STASH}
          onChanged={onChanged}
          onClose={vi.fn()}
        />
      </StashUiProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    const request = new Request(fetch.mock.calls[0]![0], fetch.mock.calls[0]![1]);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/v1/me");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
