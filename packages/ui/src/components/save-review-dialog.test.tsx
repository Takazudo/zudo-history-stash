import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createStashClient,
  type FileRecord,
  type FileRecordWithEtag,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { sha256Hex, utf8ByteLength } from "@takazudo/zudo-history-stash-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSaveMachine,
  type LineEnding,
  type SaveMachine,
  type SaveMachineState,
} from "../hooks/use-save-machine.js";
import {
  SaveReviewDialog,
  type SaveReviewCompletion,
  type SaveReviewDialogProps,
} from "./save-review-dialog.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const BASE_URL = "https://save-review.test";

interface RecordedPut {
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

interface Fixture {
  client: StashClient;
  head: FileRecordWithEtag;
  puts: RecordedPut[];
  deferNextPut: () => () => void;
  failNextPutBeforeSend: () => void;
  failNextPutResponse: () => void;
}

interface FakeBackedHostProps {
  fixture: Fixture;
  draft: string;
  lineEnding?: LineEnding;
  dialogHead?: FileRecord;
  machineHead?: Pick<FileRecord, "version" | "hash">;
  open?: boolean;
  onClose?: () => void;
  onDiscard?: () => void;
  onSaved?: (completion: SaveReviewCompletion) => void;
}

async function makeFixture(seedBody = "base\n"): Promise<Fixture> {
  const adminToken = globalThis.crypto.randomUUID();
  const fake = createFakeStash({ adminToken });
  fake.createStash(STASH);
  const puts: RecordedPut[] = [];
  let putGate: Promise<void> | null = null;
  let rejectedBeforeSend = 0;
  let lostResponses = 0;
  const fetch: StashFetch = async (input, init) => {
    const isPut = init?.method === "PUT";
    if (isPut) {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      puts.push({
        body: JSON.parse(init.body) as Record<string, unknown>,
        idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      });
      if (rejectedBeforeSend > 0) {
        rejectedBeforeSend -= 1;
        throw new TypeError("request not sent");
      }
      if (putGate !== null) {
        const gate = putGate;
        putGate = null;
        await gate;
      }
    }
    const response = await fake.fetch(input, init);
    if (isPut && lostResponses > 0) {
      lostResponses -= 1;
      throw new TypeError("response lost");
    }
    return response;
  };
  const client = createStashClient({
    baseUrl: BASE_URL,
    token: adminToken,
    fetch,
    idempotencyKey: () => {
      throw new Error("SaveReviewDialog must use the save machine's explicit key");
    },
  });
  const seeded = await client.files(STASH).put(
    PATH,
    {
      body: seedBody,
      expectedVersion: null,
      author: "fixture",
      message: "seed",
    },
    { idempotencyKey: "fixture-seed" },
  );
  if (!seeded.ok) throw new Error(seeded.error.message);
  const loaded = await client.files(STASH).get(PATH);
  if (!loaded.ok || "notModified" in loaded) throw new Error("Fixture head did not load");
  puts.length = 0;

  return {
    client,
    head: loaded.value,
    puts,
    deferNextPut() {
      let release: () => void = () => {};
      putGate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      return release;
    },
    failNextPutBeforeSend() {
      rejectedBeforeSend += 1;
    },
    failNextPutResponse() {
      lostResponses += 1;
    },
  };
}

function FakeBackedHost({
  fixture,
  draft,
  lineEnding = "lf",
  dialogHead = fixture.head,
  machineHead = dialogHead,
  open = true,
  onClose = vi.fn(),
  onDiscard = vi.fn(),
  onSaved = vi.fn(),
}: FakeBackedHostProps) {
  const machine = useSaveMachine({
    client: fixture.client,
    stash: STASH,
    path: dialogHead.path,
    head: machineHead,
    draft,
    lineEnding,
  });
  return (
    <SaveReviewDialog
      draft={draft}
      head={dialogHead}
      lineEnding={lineEnding}
      machine={machine}
      open={open}
      onClose={onClose}
      onDiscard={onDiscard}
      onSaved={onSaved}
    />
  );
}

function ReopenFakeBackedHost({
  fixture,
  draft,
  onSaved,
}: {
  fixture: Fixture;
  draft: string;
  onSaved: (completion: SaveReviewCompletion) => void;
}) {
  const [open, setOpen] = useState(true);
  const machine = useSaveMachine({
    client: fixture.client,
    stash: STASH,
    path: fixture.head.path,
    head: fixture.head,
    draft,
    lineEnding: "lf",
  });

  return (
    <>
      {!open ? <button onClick={() => setOpen(true)}>Open save review</button> : null}
      <SaveReviewDialog
        draft={draft}
        head={fixture.head}
        lineEnding="lf"
        machine={machine}
        open={open}
        onClose={() => setOpen(false)}
        onDiscard={vi.fn()}
        onSaved={onSaved}
      />
    </>
  );
}

function fileRecord(body: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path: PATH,
    version: 4,
    hash: `sha256-${"a".repeat(64)}`,
    size: utf8ByteLength(body),
    kind: "put",
    author: "Ada",
    message: "head message",
    meta: {},
    createdAt: "2026-08-26T00:00:00.000Z",
    deleted: false,
    body,
    ...overrides,
  };
}

function stubMachine(
  state: SaveMachineState,
  canRetry = false,
  overrides: Partial<SaveMachine> = {},
): SaveMachine {
  return {
    ...state,
    targetIdentity: {},
    canRetry,
    save: vi.fn<SaveMachine["save"]>().mockResolvedValue(undefined),
    retry: vi.fn<SaveMachine["retry"]>().mockResolvedValue(undefined),
    reloadAndCompare: vi
      .fn<SaveMachine["reloadAndCompare"]>()
      .mockRejectedValue(new Error("Unused reload")),
    reconcile: vi.fn<SaveMachine["reconcile"]>().mockResolvedValue(false),
    resetSession: vi.fn<SaveMachine["resetSession"]>().mockReturnValue(true),
    ...overrides,
  } as SaveMachine;
}

function renderDirect(machine: SaveMachine, overrides: Partial<SaveReviewDialogProps> = {}) {
  const props: SaveReviewDialogProps = {
    open: true,
    head: fileRecord("head\n"),
    draft: "draft\n",
    lineEnding: "lf",
    machine,
    onClose: vi.fn(),
    onDiscard: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  return { ...render(<SaveReviewDialog {...props} />), props };
}

function narrowMediaQuery(): MediaQueryList {
  return {
    matches: true,
    media: "(max-width: 56rem)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function attemptDialogClose(footerButtonName?: string): void {
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  fireEvent.click(screen.getByRole("button", { name: "Close save review" }));
  if (footerButtonName) {
    fireEvent.click(screen.getByRole("button", { name: footerButtonName }));
  }
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("SaveReviewDialog", () => {
  it("reviews and saves exact CRLF bytes through the fake backend with exact-once completion", async () => {
    const fixture = await makeFixture("base\r\n");
    const releasePut = fixture.deferNextPut();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    window.localStorage.setItem("zhs.author", "remembered-author");
    render(
      <FakeBackedHost
        draft={"base\nlocal edit\n"}
        fixture={fixture}
        lineEnding="crlf"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByRole("table", { name: "Unified diff" })).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText(/Saves as v2 on top of v1/).textContent).toContain(
      "the head is re-checked on save",
    );
    expect(screen.getByText(/Line endings: CRLF/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Author" }) as HTMLInputElement).value).toBe(
      "remembered-author",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "save review" },
    });
    const save = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    await userEvent.click(save);

    await waitFor(() => expect(fixture.puts).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Saving v2…" }).hasAttribute("disabled")).toBe(true);
    expect(fixture.puts[0]).toMatchObject({
      body: {
        body: "base\r\nlocal edit\r\n",
        expectedVersion: 1,
        author: "remembered-author",
        message: "save review",
      },
    });
    expect(fixture.puts[0]?.idempotencyKey).toBeTruthy();

    attemptDialogClose("Cancel");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => releasePut());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ state: "saved", version: 2 }));
    await act(async () => Promise.resolve());
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("blocks every close surface synchronously while reconciliation is pending", async () => {
    const reconciliation = deferred<boolean>();
    const onClose = vi.fn();
    const resetSession = vi.fn(() => true);
    const reconcile = vi.fn<SaveMachine["reconcile"]>(() => {
      attemptDialogClose("Cancel");
      return reconciliation.promise;
    });
    const save = vi.fn<SaveMachine["save"]>().mockResolvedValue(undefined);
    renderDirect(
      stubMachine({ state: "idle" }, false, {
        reconcile,
        resetSession,
        save,
      }),
      { onClose },
    );

    const saveButton = screen.getByRole("button", { name: "Save v5" });
    await waitFor(() => expect(saveButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(saveButton);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
    reconciliation.resolve(false);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("blocks close and discard synchronously while a stale reload is pending", async () => {
    const reload = deferred<FileRecordWithEtag>();
    const onClose = vi.fn();
    const onDiscard = vi.fn();
    const resetSession = vi.fn(() => true);
    const reloadAndCompare = vi.fn<SaveMachine["reloadAndCompare"]>(() => {
      attemptDialogClose("Discard");
      return reload.promise;
    });
    const machine = stubMachine(
      {
        state: "stale",
        current: {
          version: 5,
          hash: `sha256-${"b".repeat(64)}`,
          deleted: false,
          kind: "put",
          author: "Grace",
          createdAt: "2026-08-26T01:00:00.000Z",
        },
      },
      false,
      { reloadAndCompare, resetSession },
    );
    renderDirect(machine, { onClose, onDiscard });

    fireEvent.click(screen.getByRole("button", { name: "Reload & compare" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();

    await act(async () => {
      reload.resolve({
        ...fileRecord("new head\n", { version: 5, message: "new message" }),
        etag: '"new-head"',
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Close save review" }));
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("completes an asynchronously reconciled unchanged save without issuing a PUT", async () => {
    const fixture = await makeFixture("same\r\nbytes\r\n");
    const onSaved = vi.fn();
    const laggingDialogHead = {
      ...fixture.head,
      hash: `sha256-${"0".repeat(64)}`,
    };
    render(
      <FakeBackedHost
        dialogHead={laggingDialogHead}
        draft={"same\nbytes\n"}
        fixture={fixture}
        lineEnding="crlf"
        machineHead={fixture.head}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByText("No line changes to preview.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    await userEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith({ state: "unchanged", version: 1 });
    expect(fixture.puts).toHaveLength(0);
    expect(screen.getByText("No write was needed")).toBeTruthy();
  });

  it("stops on stale, reloads the displayed head, and saves against the new CAS fence", async () => {
    const fixture = await makeFixture();
    const remote = await fixture.client.files(STASH).put(
      PATH,
      {
        body: "remote edit\n",
        expectedVersion: fixture.head.version,
        author: "Bob",
        message: "remote message",
      },
      { idempotencyKey: "fixture-remote" },
    );
    if (!remote.ok || "unchanged" in remote.value) throw new Error("Remote edit did not land");
    fixture.puts.length = 0;
    const onSaved = vi.fn();
    render(<FakeBackedHost draft={"local edit\n"} fixture={fixture} onSaved={onSaved} />);

    const initialSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(initialSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(initialSave);
    const reload = await screen.findByRole("button", { name: "Reload & compare" });
    expect(screen.getByText("Head moved to v2 by Bob")).toBeTruthy();
    expect(screen.queryByText("remote message")).toBeNull();
    expect(fixture.puts).toHaveLength(1);

    await userEvent.click(reload);
    expect(await screen.findByText("remote message")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review save against head v2" })).toBeTruthy();
    expect(screen.getByText(/Saves as v3 on top of v2/)).toBeTruthy();
    const reloadedSave = screen.getByRole("button", { name: "Save v3 on top of v2" });
    await waitFor(() => expect(reloadedSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(reloadedSave);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[0]?.body.expectedVersion).toBe(1);
    expect(fixture.puts[1]?.body.expectedVersion).toBe(2);
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(fixture.puts[0]?.idempotencyKey);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ state: "saved", version: 3 }));
  });

  it("offers only the machine's exact frozen retry after a transport error", async () => {
    const fixture = await makeFixture();
    fixture.failNextPutResponse();
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <FakeBackedHost
        draft={"retry body\n"}
        fixture={fixture}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Author" }), {
      target: { value: "Lin" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "frozen metadata" },
    });
    const save = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    await userEvent.click(save);

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("History Stash request failed")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Author" }).hasAttribute("disabled")).toBe(true);
    expect(fixture.puts).toHaveLength(1);
    const releaseRetry = fixture.deferNextPut();
    fireEvent.click(retry);

    await waitFor(() => expect(fixture.puts).toHaveLength(2));
    attemptDialogClose("Cancel");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => releaseRetry());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[1]).toEqual(fixture.puts[0]);
  });

  it("blocks every close surface synchronously while a frozen retry starts", async () => {
    const retry = deferred<void>();
    const onClose = vi.fn();
    const resetSession = vi.fn(() => true);
    const retryAttempt = vi.fn<SaveMachine["retry"]>(() => {
      attemptDialogClose("Close");
      return retry.promise;
    });
    renderDirect(
      stubMachine({ state: "error", message: "response lost" }, true, {
        resetSession,
        retry: retryAttempt,
      }),
      { onClose },
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryAttempt).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(resetSession).not.toHaveBeenCalled();
    await act(async () => retry.resolve());
  });

  it("drops a retryable frozen attempt on close and starts a fresh session on reopen", async () => {
    const fixture = await makeFixture();
    fixture.failNextPutBeforeSend();
    const onSaved = vi.fn();
    render(
      <ReopenFakeBackedHost draft={"fresh session body\n"} fixture={fixture} onSaved={onSaved} />,
    );

    const firstSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(firstSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(firstSave);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(fixture.puts).toHaveLength(1);
    const firstKey = fixture.puts[0]?.idempotencyKey;

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Open save review" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    const secondSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(secondSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(secondSave);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fixture.puts).toHaveLength(2);
    expect(firstKey).toBeTruthy();
    expect(fixture.puts[1]?.idempotencyKey).toBeTruthy();
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(firstKey);
  });

  it("restores the displayed prop head and matching CAS fence after reload, close, and reopen", async () => {
    const fixture = await makeFixture();
    const advanced = await fixture.client.files(STASH).put(
      PATH,
      {
        body: "remote edit\n",
        expectedVersion: fixture.head.version,
        author: "Bob",
        message: "remote",
      },
      { idempotencyKey: "fixture-remote-before-reopen" },
    );
    if (!advanced.ok || "unchanged" in advanced.value) throw new Error("Remote edit did not land");
    fixture.puts.length = 0;
    render(<ReopenFakeBackedHost draft={"local edit\n"} fixture={fixture} onSaved={vi.fn()} />);

    const firstSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(firstSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(firstSave);
    await userEvent.click(await screen.findByRole("button", { name: "Reload & compare" }));
    expect(
      await screen.findByRole("heading", { name: "Review save against head v2" }),
    ).toBeTruthy();
    expect(screen.getByText(/Saves as v3 on top of v2/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Close save review" }));
    await userEvent.click(screen.getByRole("button", { name: "Open save review" }));
    expect(screen.getByRole("heading", { name: "Review save against head v1" })).toBeTruthy();
    expect(screen.getByText(/Saves as v2 on top of v1/)).toBeTruthy();

    const reopenedSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(reopenedSave.hasAttribute("disabled")).toBe(false));
    await userEvent.click(reopenedSave);
    await screen.findByRole("button", { name: "Reload & compare" });

    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[0]?.body.expectedVersion).toBe(1);
    expect(fixture.puts[1]?.body.expectedVersion).toBe(1);
  });

  it("shows Close without Retry for a nonretryable error", async () => {
    const machine = stubMachine({ state: "error", message: "validation failed" }, false);
    const { props } = renderDirect(machine);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(machine.retry).not.toHaveBeenCalled();
    expect(machine.save).not.toHaveBeenCalled();
  });

  it("enforces UTF-8 byte limits and remembers the author safely", () => {
    window.localStorage.setItem("zhs.author", "Ada");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderDirect(stubMachine({ state: "idle" }));
    const author = screen.getByRole("textbox", { name: "Author" }) as HTMLInputElement;
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(author.value).toBe("Ada");

    fireEvent.change(author, { target: { value: "日".repeat(100) } });
    fireEvent.change(message, { target: { value: "日".repeat(1_000) } });

    expect(utf8ByteLength(author.value)).toBe(198);
    expect(utf8ByteLength(message.value)).toBe(1_998);
    expect(screen.getByText("198 / 200 UTF-8 bytes")).toBeTruthy();
    expect(screen.getByText("1998 / 2000 UTF-8 bytes")).toBeTruthy();
    expect(setItem).toHaveBeenLastCalledWith("zhs.author", author.value);
  });

  it("keeps the author field usable when localStorage reads and writes throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota");
    });
    renderDirect(stubMachine({ state: "idle" }));
    const author = screen.getByRole("textbox", { name: "Author" }) as HTMLInputElement;
    expect(author.value).toBe("");

    expect(() => fireEvent.change(author, { target: { value: "Still usable" } })).not.toThrow();
    expect(author.value).toBe("Still usable");
  });

  it("resets target-local fields and ignores an old hash across an opaque target switch", async () => {
    const secondBody = "second head\n";
    const sharedHead = fileRecord(secondBody, {
      path: "same.txt",
      version: 7,
      hash: await sha256Hex(secondBody),
    });
    let resolveOldDigest!: (value: ArrayBuffer) => void;
    const oldDigest = new Promise<ArrayBuffer>((resolveDigest) => {
      resolveOldDigest = resolveDigest;
    });
    const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementationOnce(() => oldDigest)
      .mockImplementation((algorithm, data) => nativeDigest(algorithm, data));
    const firstMachine = stubMachine({ state: "idle" });
    const secondMachine = stubMachine({ state: "idle" });
    const onSaved = vi.fn();
    const rendered = render(
      <SaveReviewDialog
        draft="first draft\n"
        head={sharedHead}
        lineEnding="lf"
        machine={firstMachine}
        open={true}
        onClose={vi.fn()}
        onDiscard={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "old target message" },
    });
    expect(digest).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <SaveReviewDialog
        draft={secondBody}
        head={sharedHead}
        lineEnding="lf"
        machine={secondMachine}
        open={true}
        onClose={vi.fn()}
        onDiscard={vi.fn()}
        onSaved={onSaved}
      />,
    );

    expect(screen.getByRole("heading", { name: "Review save against head v7" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
    const save = screen.getByRole("button", { name: "Save v8" });
    await act(async () => Promise.resolve());
    expect(save.hasAttribute("disabled")).toBe(true);

    await act(async () => resolveOldDigest(new Uint8Array(32).buffer));
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("does not deliver an old client completion when identical head coordinates switch targets", async () => {
    const firstFixture = await makeFixture("shared head\n");
    const secondFixture = await makeFixture("shared head\n");
    const releaseFirstSave = firstFixture.deferNextPut();
    const onSaved = vi.fn();
    const rendered = render(
      <FakeBackedHost draft={"first client edit\n"} fixture={firstFixture} onSaved={onSaved} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "first client message" },
    });
    const firstSave = screen.getByRole("button", { name: "Save v2" });
    await waitFor(() => expect(firstSave.hasAttribute("disabled")).toBe(false));
    fireEvent.click(firstSave);
    await waitFor(() => expect(firstFixture.puts).toHaveLength(1));

    rendered.rerender(
      <FakeBackedHost draft={"second client edit\n"} fixture={secondFixture} onSaved={onSaved} />,
    );
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(screen.getByRole("heading", { name: "Review save against head v1" })).toBeTruthy();

    releaseFirstSave();
    await waitFor(async () => {
      const saved = await firstFixture.client.files(STASH).get(PATH);
      expect(saved.ok && !("notModified" in saved) ? saved.value.version : 0).toBe(2);
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Review save against head v1" })).toBeTruthy();
  });

  it("ignores a reloaded record that resolves after an opaque target switch", async () => {
    const sharedHead = fileRecord("shared head\n");
    const oldReload = deferred<FileRecordWithEtag>();
    const oldMachine = stubMachine(
      {
        state: "stale",
        current: {
          version: 5,
          hash: `sha256-${"b".repeat(64)}`,
          deleted: false,
          kind: "put",
          author: "Old author",
          createdAt: "2026-08-26T01:00:00.000Z",
        },
      },
      false,
      {
        reloadAndCompare: vi.fn(() => oldReload.promise),
      },
    );
    const nextMachine = stubMachine({ state: "idle" });
    const onSaved = vi.fn();
    const rendered = render(
      <SaveReviewDialog
        draft="old draft\n"
        head={sharedHead}
        lineEnding="lf"
        machine={oldMachine}
        open={true}
        onClose={vi.fn()}
        onDiscard={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload & compare" }));

    rendered.rerender(
      <SaveReviewDialog
        draft="new draft\n"
        head={sharedHead}
        lineEnding="lf"
        machine={nextMachine}
        open={true}
        onClose={vi.fn()}
        onDiscard={vi.fn()}
        onSaved={onSaved}
      />,
    );
    oldReload.resolve({
      ...fileRecord("old reloaded head\n", {
        version: 9,
        author: "Old author",
        message: "old reloaded message",
      }),
      etag: '"old-reload"',
    });
    await act(async () => Promise.resolve());

    expect(screen.queryByText("old reloaded message")).toBeNull();
    expect(screen.getByRole("heading", { name: "Review save against head v4" })).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("routes Escape only to onClose and Discard only to the explicit stale action", async () => {
    const onClose = vi.fn();
    const onDiscard = vi.fn();
    const machine = stubMachine({
      state: "stale",
      current: {
        version: 5,
        hash: `sha256-${"b".repeat(64)}`,
        deleted: false,
        kind: "put",
        author: "Grace",
        createdAt: "2026-08-26T01:00:00.000Z",
      },
    });
    renderDirect(machine, { onClose, onDiscard });
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forces unified view and disables Split under the 56rem media query", () => {
    window.localStorage.setItem("zhs.diff.layout", "split");
    const matchMedia = vi.fn(() => narrowMediaQuery());
    vi.stubGlobal("matchMedia", matchMedia);
    renderDirect(stubMachine({ state: "idle" }));

    const split = screen.getByRole("button", { name: "Split" });
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 56rem)");
    expect(split.hasAttribute("disabled")).toBe(true);
    expect(split.getAttribute("aria-pressed")).toBe("true");
    expect(split.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Unified diff" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Split diff" })).toBeNull();
  });

  it("keeps its leaf CSS namespaced, tokenized, responsive, and scroll-contained", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/components/save-review-dialog.css"),
      "utf8",
    );
    const classes = [...css.matchAll(/\.([_a-zA-Z][-_a-zA-Z0-9]*)/gu)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(20);
    expect(classes.every((className) => className?.startsWith("zhs-"))).toBe(true);
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(css).not.toMatch(/\brgba?\(/u);
    expect(css).not.toMatch(/\dpx\b/u);
    expect(css).toContain("@media (max-width: 56rem)");
    expect(css).toMatch(
      /\.zhs-save-review-dialog__diff\s*\{[^}]*overflow: auto;[^}]*overscroll-behavior: contain;/su,
    );
    expect(css).toContain("color: var(--theme-success)");
    expect(css).toContain("color: var(--theme-error)");
  });
});
