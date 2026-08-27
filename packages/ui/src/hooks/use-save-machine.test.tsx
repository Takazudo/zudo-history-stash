import { act, render, renderHook } from "@testing-library/react";
import {
  createStashClient,
  type FileRecordWithEtag,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { DIFF_MAX_BYTES, MAX_MESSAGE_BYTES } from "@takazudo/zudo-history-stash-core";
import { startTransition, Suspense, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCandidateDiff } from "./use-candidate-diff.js";
import { useSaveMachine, type SaveMachine, type SaveMachineOptions } from "./use-save-machine.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";
const STASH = "notes";
const PATH = "docs/readme.txt";
const OTHER_PATH = "docs/other.txt";

interface RecordedPut {
  idempotencyKey: string | null;
  body: Record<string, unknown>;
}

interface Fixture {
  client: StashClient;
  head: FileRecordWithEtag;
  otherHead: FileRecordWithEtag;
  puts: RecordedPut[];
  failNextPut: () => void;
  failNextPutBeforeSend: () => void;
  deferNextGet: () => () => void;
  deferNextPut: () => () => void;
}

type HookProps = SaveMachineOptions;

const NEVER_SETTLES = new Promise<void>(() => {});

function SaveMachineProbe({
  machineOptions,
  suspend,
  onCommit,
}: {
  machineOptions: HookProps;
  suspend: boolean;
  onCommit: (machine: SaveMachine) => void;
}) {
  const machine = useSaveMachine(machineOptions);
  useLayoutEffect(() => onCommit(machine), [machine, onCommit]);
  if (suspend) throw NEVER_SETTLES;
  return <span>{machine.state}</span>;
}

async function makeFixture(seedBody = "base\n"): Promise<Fixture> {
  let now = Date.UTC(2026, 0, 1);
  const fake = createFakeStash({
    adminToken: ADMIN_TOKEN,
    now: () => now++,
  });
  fake.createStash(STASH);

  const puts: RecordedPut[] = [];
  let rejectedPuts = 0;
  let rejectedPutsBeforeSend = 0;
  let getGate: Promise<void> | null = null;
  let putGate: Promise<void> | null = null;
  const fetch: StashFetch = async (input, init) => {
    const isPut = init?.method === "PUT";
    const isGet = init?.method === undefined || init.method === "GET";
    if (isGet && getGate !== null) {
      const gate = getGate;
      getGate = null;
      await gate;
    }
    if (init?.method === "PUT") {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      puts.push({
        idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      if (rejectedPutsBeforeSend > 0) {
        rejectedPutsBeforeSend -= 1;
        throw new TypeError("request not sent");
      }
      if (putGate !== null) {
        const gate = putGate;
        putGate = null;
        await gate;
      }
    }
    const response = await fake.fetch(input, init);
    if (isPut && rejectedPuts > 0) {
      rejectedPuts -= 1;
      throw new TypeError("response lost");
    }
    return response;
  };
  const client = createStashClient({
    baseUrl: BASE_URL,
    token: ADMIN_TOKEN,
    fetch,
    idempotencyKey: () => {
      throw new Error("The save hook must provide an explicit idempotency key");
    },
  });

  const seeded = await client
    .files(STASH)
    .put(
      PATH,
      { body: seedBody, expectedVersion: null, author: "fixture", message: "seed" },
      { idempotencyKey: "fixture-seed" },
    );
  if (!seeded.ok) throw new Error(seeded.error.message);
  const otherSeeded = await client
    .files(STASH)
    .put(
      OTHER_PATH,
      { body: "other\n", expectedVersion: null, author: "fixture", message: "seed other" },
      { idempotencyKey: "fixture-seed-other" },
    );
  if (!otherSeeded.ok) throw new Error(otherSeeded.error.message);

  const loaded = await client.files(STASH).get(PATH);
  if (!loaded.ok || "notModified" in loaded) throw new Error("Fixture head did not load");
  const otherLoaded = await client.files(STASH).get(OTHER_PATH);
  if (!otherLoaded.ok || "notModified" in otherLoaded) {
    throw new Error("Alternate fixture head did not load");
  }
  puts.length = 0;

  return {
    client,
    head: loaded.value,
    otherHead: otherLoaded.value,
    puts,
    failNextPut() {
      rejectedPuts += 1;
    },
    failNextPutBeforeSend() {
      rejectedPutsBeforeSend += 1;
    },
    deferNextGet() {
      let release = () => {};
      getGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    deferNextPut() {
      let release = () => {};
      putGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function options(fixture: Fixture, overrides: Partial<HookProps> = {}): HookProps {
  return {
    client: fixture.client,
    stash: STASH,
    path: PATH,
    head: fixture.head,
    draft: "local edit\n",
    lineEnding: "lf",
    ...overrides,
  };
}

function deferSha256(hash: string | null): {
  resolve: () => void;
  restore: () => void;
} {
  if (hash === null || !hash.startsWith("sha256-")) throw new Error("Expected a SHA-256 hash");
  const hex = hash.slice("sha256-".length);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  let resolveDigest = (_value: ArrayBuffer) => {};
  const pendingDigest = new Promise<ArrayBuffer>((resolve) => {
    resolveDigest = resolve;
  });
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(() => pendingDigest);
  return {
    resolve() {
      resolveDigest(bytes.buffer);
    },
    restore() {
      spy.mockRestore();
    },
  };
}

describe("useSaveMachine", () => {
  it("exposes a stable identity that changes for client, stash, or path targets", async () => {
    const firstFixture = await makeFixture();
    const secondFixture = await makeFixture();
    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps: options(firstFixture),
    });
    const firstIdentity = result.current.targetIdentity;

    rerender(options(firstFixture, { draft: "same target, new draft\n" }));
    expect(result.current.targetIdentity).toBe(firstIdentity);

    rerender(options(firstFixture, { stash: "archive" }));
    const stashIdentity = result.current.targetIdentity;
    expect(stashIdentity).not.toBe(firstIdentity);

    rerender(
      options(secondFixture, {
        client: secondFixture.client,
        head: secondFixture.head,
      }),
    );
    const clientIdentity = result.current.targetIdentity;
    expect(clientIdentity).not.toBe(stashIdentity);

    rerender(
      options(secondFixture, {
        client: secondFixture.client,
        path: OTHER_PATH,
        head: secondFixture.otherHead,
      }),
    );
    expect(result.current.targetIdentity).not.toBe(clientIdentity);
  });

  it("retries a transport failure with the same frozen body, fence, metadata, and key", async () => {
    const fixture = await makeFixture();
    fixture.failNextPut();
    const initialProps = options(fixture, {
      draft: "base\nlocal edit\n",
      lineEnding: "crlf",
    });
    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps,
    });

    await act(async () => {
      await result.current.save({ author: "alice", message: "first attempt" });
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canRetry).toBe(true);
    expect(fixture.puts).toHaveLength(1);

    rerender(
      options(fixture, {
        head: { version: 99, hash: "sha256-not-the-frozen-head" },
        draft: "different rerendered text\n",
        lineEnding: "lf",
      }),
    );
    expect(result.current.canRetry).toBe(true);
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state).toBe("saved");
    expect(result.current.canRetry).toBe(false);
    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[1]).toEqual(fixture.puts[0]);
    expect(fixture.puts[0]?.idempotencyKey).toBeTruthy();
    expect(fixture.puts[0]?.body).toEqual({
      body: "base\r\nlocal edit\r\n",
      expectedVersion: fixture.head.version,
      author: "alice",
      message: "first attempt",
    });
  });

  it("resets a settled retry session and mints a fresh canonical key", async () => {
    const fixture = await makeFixture();
    fixture.failNextPutBeforeSend();
    const { result } = renderHook(() => useSaveMachine(options(fixture)));

    await act(async () => {
      await result.current.save({ author: "alice", message: "failed session" });
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canRetry).toBe(true);
    const failedKey = fixture.puts[0]?.idempotencyKey;

    let reset = false;
    act(() => {
      reset = result.current.resetSession();
    });
    expect(reset).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(result.current.canRetry).toBe(false);
    await act(async () => {
      await result.current.retry();
    });
    expect(fixture.puts).toHaveLength(1);

    await act(async () => {
      await result.current.save({ author: "alice", message: "fresh session" });
    });
    expect(result.current.state).toBe("saved");
    expect(fixture.puts).toHaveLength(2);
    expect(failedKey).toBeTruthy();
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(failedKey);
  });

  it("refuses to reset while a save, reload, or reconciliation is pending", async () => {
    const fixture = await makeFixture();
    const releaseSave = fixture.deferNextPut();
    const saving = renderHook(() => useSaveMachine(options(fixture)));
    let savePromise!: Promise<void>;
    act(() => {
      savePromise = saving.result.current.save({ author: "alice", message: "pending" });
    });
    expect(saving.result.current.resetSession()).toBe(false);
    releaseSave();
    await act(async () => savePromise);

    const reloading = renderHook(() => useSaveMachine(options(fixture)));
    const releaseReload = fixture.deferNextGet();
    let reloadPromise!: Promise<FileRecordWithEtag>;
    act(() => {
      reloadPromise = reloading.result.current.reloadAndCompare();
    });
    expect(reloading.result.current.resetSession()).toBe(false);
    releaseReload();
    await act(async () => reloadPromise);

    const reconciling = renderHook(() =>
      useSaveMachine(options(fixture, { draft: fixture.head.body ?? "" })),
    );
    const digest = deferSha256(fixture.head.hash);
    let reconcilePromise!: Promise<boolean>;
    act(() => {
      reconcilePromise = reconciling.result.current.reconcile();
    });
    expect(reconciling.result.current.resetSession()).toBe(false);
    digest.resolve();
    await act(async () => reconcilePromise);
    digest.restore();
  });

  it("stops after a stale PUT, reloads the head, then saves with a fresh fence and key", async () => {
    const fixture = await makeFixture();
    const advanced = await fixture.client.files(STASH).put(
      PATH,
      {
        body: "remote edit\n",
        expectedVersion: fixture.head.version,
        author: "bob",
        message: "remote",
      },
      { idempotencyKey: "fixture-remote" },
    );
    if (!advanced.ok || "unchanged" in advanced.value) throw new Error("Fixture did not advance");
    fixture.puts.length = 0;

    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps: options(fixture),
    });
    await act(async () => {
      await result.current.save({ author: "alice", message: "local" });
    });

    expect(result.current.state).toBe("stale");
    expect(result.current.canRetry).toBe(false);
    if (result.current.state === "stale") {
      expect(result.current.current.version).toBe(advanced.value.version);
    }
    expect(fixture.puts).toHaveLength(1);
    await act(async () => Promise.resolve());
    expect(fixture.puts).toHaveLength(1);
    await act(async () => {
      await result.current.retry();
    });
    expect(fixture.puts).toHaveLength(1);

    let reloaded: FileRecordWithEtag | undefined;
    await act(async () => {
      reloaded = await result.current.reloadAndCompare();
    });
    expect(reloaded?.version).toBe(advanced.value.version);
    expect(result.current.state).toBe("idle");

    await act(async () => {
      await result.current.save({ author: "alice", message: "after reload" });
    });

    expect(result.current.state).toBe("saved");
    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[0]?.body.expectedVersion).toBe(fixture.head.version);
    expect(fixture.puts[1]?.body.expectedVersion).toBe(advanced.value.version);
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(fixture.puts[0]?.idempotencyKey);

    if (result.current.state !== "saved") throw new Error("Reloaded save did not complete");
    const internallySavedVersion = result.current.version;
    rerender(
      options(fixture, {
        head: reloaded,
        draft: "another local edit\n",
      }),
    );
    await act(async () => {
      await result.current.save({ author: "alice", message: "after delayed head sync" });
    });
    expect(result.current.state).toBe("saved");
    expect(fixture.puts).toHaveLength(3);
    expect(fixture.puts[2]?.body.expectedVersion).toBe(internallySavedVersion);
  });

  it("verifies a foreign head as stale without advancing the effective CAS fence", async () => {
    const fixture = await makeFixture();
    const advanced = await fixture.client.files(STASH).put(
      PATH,
      {
        body: "foreign live body\n",
        expectedVersion: fixture.head.version,
        author: "peer",
        message: "foreign live update",
      },
      { idempotencyKey: "fixture-live-foreign" },
    );
    if (!advanced.ok || "unchanged" in advanced.value) throw new Error("Fixture did not advance");
    fixture.puts.length = 0;
    const { result } = renderHook(() => useSaveMachine(options(fixture)));

    let unchanged = true;
    await act(async () => {
      unchanged = await result.current.reconcile({ verifyCurrentHead: true });
    });

    expect(unchanged).toBe(false);
    expect(result.current.state).toBe("stale");
    if (result.current.state === "stale") {
      expect(result.current.current.version).toBe(advanced.value.version);
    }
    expect(fixture.puts).toHaveLength(0);

    await act(async () => {
      await result.current.save({ author: "alice", message: "still fenced" });
    });
    expect(result.current.state).toBe("stale");
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]?.body.expectedVersion).toBe(fixture.head.version);
  });

  it("invalidates a failed target's retry when the hook changes targets", async () => {
    const fixture = await makeFixture();
    fixture.failNextPutBeforeSend();
    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps: options(fixture),
    });

    await act(async () => {
      await result.current.save({ author: "alice", message: "target A" });
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canRetry).toBe(true);

    rerender(
      options(fixture, {
        path: OTHER_PATH,
        head: fixture.otherHead,
        draft: "target B\n",
      }),
    );
    expect(result.current.state).toBe("idle");
    expect(result.current.canRetry).toBe(false);

    await act(async () => {
      await result.current.retry();
    });
    expect(fixture.puts).toHaveLength(1);
    const targetA = await fixture.client.files(STASH).get(PATH);
    if (!targetA.ok || "notModified" in targetA) throw new Error("Target A did not load");
    expect(targetA.value.version).toBe(fixture.head.version);
  });

  it("does not expose a transport retry for business or reload errors", async () => {
    const fixture = await makeFixture();
    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps: options(fixture),
    });

    await act(async () => {
      await result.current.save({
        author: "alice",
        message: "x".repeat(MAX_MESSAGE_BYTES + 1),
      });
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canRetry).toBe(false);
    await act(async () => {
      await result.current.retry();
    });
    expect(fixture.puts).toHaveLength(1);

    rerender(options(fixture, { path: "docs/missing.txt" }));
    expect(result.current.state).toBe("idle");
    await act(async () => {
      await expect(result.current.reloadAndCompare()).rejects.toThrow("File not found");
    });
    expect(result.current.state).toBe("error");
    expect(result.current.canRetry).toBe(false);
  });

  it("lets a new target save while the old target settles and ignores the old completion", async () => {
    const fixture = await makeFixture();
    const releaseTargetA = fixture.deferNextPut();
    const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
      initialProps: options(fixture, { draft: "target A edit\n" }),
    });

    let targetASave!: Promise<void>;
    act(() => {
      targetASave = result.current.save({ author: "alice", message: "target A" });
    });
    expect(result.current.state).toBe("saving");

    rerender(
      options(fixture, {
        path: OTHER_PATH,
        head: fixture.otherHead,
        draft: "target B edit\n",
      }),
    );
    expect(result.current.state).toBe("idle");
    await act(async () => {
      await result.current.save({ author: "alice", message: "target B" });
    });
    expect(result.current.state).toBe("saved");
    if (result.current.state !== "saved") throw new Error("Target B did not save");
    const targetBChangeId = result.current.changeId;

    releaseTargetA();
    await act(async () => {
      await targetASave;
    });

    expect(result.current.state).toBe("saved");
    if (result.current.state === "saved") {
      expect(result.current.changeId).toBe(targetBChangeId);
    }
    expect(fixture.puts).toHaveLength(2);
  });

  it("does not let a suspended same-target render change the visible save callback", async () => {
    const fixture = await makeFixture();
    let committedMachine: SaveMachine | null = null;
    const onCommit = (machine: SaveMachine) => {
      committedMachine = machine;
    };
    const getCommittedMachine = (): SaveMachine => {
      if (committedMachine === null) throw new Error("Save machine did not commit");
      return committedMachine;
    };
    const committedOptions = options(fixture, { draft: "committed draft\n" });
    const view = render(
      <Suspense fallback={<span>suspended</span>}>
        <SaveMachineProbe machineOptions={committedOptions} suspend={false} onCommit={onCommit} />
      </Suspense>,
    );

    await act(async () => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={<span>suspended</span>}>
            <SaveMachineProbe
              machineOptions={options(fixture, {
                head: { version: 42, hash: `sha256-${"0".repeat(64)}` },
                draft: "uncommitted draft\n",
              })}
              suspend
              onCommit={onCommit}
            />
          </Suspense>,
        );
      });
      await Promise.resolve();
    });

    expect(view.container.textContent).toBe("idle");
    await act(async () => {
      await getCommittedMachine().save({ author: "alice", message: "visible save" });
    });

    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]?.body).toMatchObject({
      body: "committed draft\n",
      expectedVersion: fixture.head.version,
    });
  });

  it("does not let a suspended target render invalidate the visible reconciliation", async () => {
    const fixture = await makeFixture();
    let committedMachine: SaveMachine | null = null;
    const onCommit = (machine: SaveMachine) => {
      committedMachine = machine;
    };
    const getCommittedMachine = (): SaveMachine => {
      if (committedMachine === null) throw new Error("Save machine did not commit");
      return committedMachine;
    };
    const view = render(
      <Suspense fallback={<span>suspended</span>}>
        <SaveMachineProbe
          machineOptions={options(fixture, { draft: fixture.head.body ?? "" })}
          suspend={false}
          onCommit={onCommit}
        />
      </Suspense>,
    );

    await act(async () => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={<span>suspended</span>}>
            <SaveMachineProbe
              machineOptions={options(fixture, {
                path: OTHER_PATH,
                head: fixture.otherHead,
                draft: fixture.otherHead.body ?? "",
              })}
              suspend
              onCommit={onCommit}
            />
          </Suspense>,
        );
      });
      await Promise.resolve();
    });

    expect(view.container.textContent).toBe("idle");
    let reconciled = false;
    await act(async () => {
      reconciled = await getCommittedMachine().reconcile();
    });

    expect(reconciled).toBe(true);
    expect(view.container.textContent).toBe("unchanged");
    expect(fixture.puts).toHaveLength(0);
  });

  it("reconciles the hash of CRLF-pinned bytes as unchanged without a PUT", async () => {
    const fixture = await makeFixture("same\r\nbytes\r\n");
    const { result } = renderHook(() =>
      useSaveMachine(
        options(fixture, {
          draft: "same\nbytes\n",
          lineEnding: "crlf",
        }),
      ),
    );

    let same = false;
    await act(async () => {
      same = await result.current.reconcile();
    });

    expect(same).toBe(true);
    expect(result.current.state).toBe("unchanged");
    if (result.current.state === "unchanged") {
      expect(result.current.version).toBe(fixture.head.version);
    }
    expect(fixture.puts).toHaveLength(0);
  });

  it.each(["draft", "head", "target"] as const)(
    "ignores a deferred reconciliation after the %s changes",
    async (change) => {
      const fixture = await makeFixture();
      const { result, rerender } = renderHook((props: HookProps) => useSaveMachine(props), {
        initialProps: options(fixture, { draft: fixture.head.body ?? "" }),
      });
      const digest = deferSha256(fixture.head.hash);
      let reconciliation!: Promise<boolean>;
      act(() => {
        reconciliation = result.current.reconcile();
      });

      if (change === "draft") {
        rerender(options(fixture, { draft: "changed draft\n" }));
      } else if (change === "head") {
        rerender(
          options(fixture, {
            head: { version: fixture.head.version + 1, hash: `sha256-${"0".repeat(64)}` },
            draft: fixture.head.body ?? "",
          }),
        );
      } else {
        rerender(
          options(fixture, {
            path: OTHER_PATH,
            head: fixture.otherHead,
            draft: fixture.otherHead.body ?? "",
          }),
        );
      }

      let reconciled = true;
      await act(async () => {
        digest.resolve();
        reconciled = await reconciliation;
      });
      digest.restore();

      expect(reconciled).toBe(false);
      expect(result.current.state).toBe("idle");
    },
  );

  it.each(["save", "reload"] as const)(
    "ignores a deferred reconciliation when a %s starts",
    async (operation) => {
      const fixture = await makeFixture();
      const { result } = renderHook(() =>
        useSaveMachine(options(fixture, { draft: fixture.head.body ?? "" })),
      );
      const digest = deferSha256(fixture.head.hash);
      let reconciliation!: Promise<boolean>;
      act(() => {
        reconciliation = result.current.reconcile();
      });
      digest.restore();

      if (operation === "save") {
        await act(async () => {
          await result.current.save({ author: "alice", message: "save wins" });
        });
        expect(result.current.state).toBe("saved");
      } else {
        await act(async () => {
          await result.current.reloadAndCompare();
        });
        expect(result.current.state).toBe("idle");
      }

      let reconciled = true;
      await act(async () => {
        digest.resolve();
        reconciled = await reconciliation;
      });

      expect(reconciled).toBe(false);
      expect(result.current.state).toBe(operation === "save" ? "saved" : "idle");
    },
  );

  it("mints a new key after the editor hook is remounted", async () => {
    const fixture = await makeFixture();
    fixture.failNextPut();
    const first = renderHook(() => useSaveMachine(options(fixture)));
    await act(async () => {
      await first.result.current.save({ author: "alice", message: "first mount" });
    });
    first.unmount();

    fixture.failNextPut();
    const second = renderHook(() => useSaveMachine(options(fixture)));
    await act(async () => {
      await second.result.current.save({ author: "alice", message: "second mount" });
    });

    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[0]?.idempotencyKey).toBeTruthy();
    expect(fixture.puts[1]?.idempotencyKey).toBeTruthy();
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(fixture.puts[0]?.idempotencyKey);
  });

  it("allows a save even when the local candidate diff is oversized", async () => {
    const fixture = await makeFixture();
    const draft = "x".repeat(DIFF_MAX_BYTES + 1);
    const { result } = renderHook(() => {
      const candidate = useCandidateDiff({
        baseText: fixture.head.body ?? "",
        draftText: draft,
        context: 3,
      });
      const save = useSaveMachine(options(fixture, { draft }));
      return { candidate, save };
    });

    expect(result.current.candidate.oversized).toBe(true);
    await act(async () => {
      await result.current.save.save({ author: "alice", message: "large edit" });
    });

    expect(result.current.save.state).toBe("saved");
    expect(fixture.puts).toHaveLength(1);
    expect(fixture.puts[0]?.body.body).toBe(draft);
  });
});
