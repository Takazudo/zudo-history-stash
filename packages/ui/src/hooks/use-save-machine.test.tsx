import { act, renderHook } from "@testing-library/react";
import {
  createStashClient,
  type FileRecordWithEtag,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { DIFF_MAX_BYTES } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { useCandidateDiff } from "./use-candidate-diff.js";
import { useSaveMachine, type SaveMachineOptions } from "./use-save-machine.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";
const STASH = "notes";
const PATH = "docs/readme.txt";

interface RecordedPut {
  idempotencyKey: string | null;
  body: Record<string, unknown>;
}

interface Fixture {
  client: StashClient;
  head: FileRecordWithEtag;
  puts: RecordedPut[];
  failNextPut: () => void;
}

type HookProps = SaveMachineOptions;

async function makeFixture(seedBody = "base\n"): Promise<Fixture> {
  let now = Date.UTC(2026, 0, 1);
  const fake = createFakeStash({
    adminToken: ADMIN_TOKEN,
    now: () => now++,
  });
  fake.createStash(STASH);

  const puts: RecordedPut[] = [];
  let rejectedPuts = 0;
  const fetch: StashFetch = async (input, init) => {
    const isPut = init?.method === "PUT";
    if (init?.method === "PUT") {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      puts.push({
        idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
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

  const loaded = await client.files(STASH).get(PATH);
  if (!loaded.ok || "notModified" in loaded) throw new Error("Fixture head did not load");
  puts.length = 0;

  return {
    client,
    head: loaded.value,
    puts,
    failNextPut() {
      rejectedPuts += 1;
    },
  };
}

function options(
  fixture: Fixture,
  overrides: Partial<Pick<HookProps, "head" | "draft" | "lineEnding">> = {},
): HookProps {
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

describe("useSaveMachine", () => {
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
    expect(fixture.puts).toHaveLength(1);

    rerender(
      options(fixture, {
        head: { version: 99, hash: "sha256-not-the-frozen-head" },
        draft: "different rerendered text\n",
        lineEnding: "lf",
      }),
    );
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.state).toBe("saved");
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

    rerender(options(fixture, { head: reloaded }));
    await act(async () => {
      await result.current.save({ author: "alice", message: "after reload" });
    });

    expect(result.current.state).toBe("saved");
    expect(fixture.puts).toHaveLength(2);
    expect(fixture.puts[0]?.body.expectedVersion).toBe(fixture.head.version);
    expect(fixture.puts[1]?.body.expectedVersion).toBe(advanced.value.version);
    expect(fixture.puts[1]?.idempotencyKey).not.toBe(fixture.puts[0]?.idempotencyKey);
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
