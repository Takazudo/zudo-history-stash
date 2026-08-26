import {
  createStashClient,
  type FileRecordWithEtag,
  type StashClient,
  type StashFetch,
  type VersionRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import type { RollbackSuccess } from "./rollback-dialog.js";
import { TombstoneRestore, type TombstoneRestoreProps } from "./tombstone-restore.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const OTHER_PATH = "docs/other.txt";
const BASE_URL = "https://tombstone-restore.test";

interface TombstoneFixture {
  head: FileRecordWithEtag;
  versions: VersionRecord[];
}

interface Fixture {
  fake: FakeStash;
  fetch: ReturnType<typeof vi.fn<StashFetch>>;
  client: StashClient;
  rollbackPaths: string[];
  deferNextRollback: () => () => void;
  seedTombstone: (path: string, liveBodies?: readonly string[]) => Promise<TombstoneFixture>;
}

async function makeFixture(): Promise<Fixture> {
  const adminToken = "restore-admin-token";
  const fake = createFakeStash({ adminToken });
  fake.createStash(STASH);
  const rollbackPaths: string[] = [];
  let rollbackGate: Promise<void> | null = null;
  const fetch = vi.fn<StashFetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isRollback = request.method === "POST" && url.pathname.includes("/rollback/");
    if (isRollback) {
      rollbackPaths.push(decodeURIComponent(url.pathname.split("/rollback/")[1] ?? ""));
      if (rollbackGate !== null) {
        const gate = rollbackGate;
        rollbackGate = null;
        await gate;
      }
    }
    return fake.fetch(input, init);
  });
  const client = createStashClient({ baseUrl: BASE_URL, token: adminToken, fetch });
  let seedSequence = 0;

  return {
    fake,
    fetch,
    client,
    rollbackPaths,
    deferNextRollback() {
      let release: () => void = () => {};
      rollbackGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async seedTombstone(path, liveBodies = ["first\n", "second\n"]) {
      let expectedVersion: number | null = null;
      for (const body of liveBodies) {
        seedSequence += 1;
        const put = await client.files(STASH).put(
          path,
          {
            body,
            expectedVersion,
            author: "fixture",
            message: `live ${seedSequence}`,
          },
          { idempotencyKey: `fixture-put-${seedSequence}` },
        );
        if (!put.ok) throw new Error(put.error.message);
        expectedVersion = put.value.version;
      }
      if (expectedVersion === null) throw new Error("A tombstone fixture needs a live version");
      seedSequence += 1;
      const deleted = await client
        .files(STASH)
        .delete(
          path,
          { expectedVersion, author: "fixture", message: "delete fixture" },
          { idempotencyKey: `fixture-delete-${seedSequence}` },
        );
      if (!deleted.ok) throw new Error(deleted.error.message);
      const headResult = await client.files(STASH).get(path, { version: deleted.value.version });
      if (!headResult.ok || "notModified" in headResult) throw new Error("Missing tombstone head");
      const history = await client.files(STASH).history(path);
      if (!history.ok) throw new Error(history.error.message);
      return { head: headResult.value, versions: history.value.versions };
    },
  };
}

function renderRestore(
  fixture: Fixture,
  tombstone: TombstoneFixture,
  overrides: Partial<TombstoneRestoreProps> = {},
) {
  const props: TombstoneRestoreProps = {
    stash: STASH,
    path: PATH,
    head: tombstone.head,
    versions: tombstone.versions,
    onChanged: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <StashUiProvider client={fixture.client}>
        <TombstoneRestore {...props} />
      </StashUiProvider>,
    ),
  };
}

function RestoreHost({ fixture, props }: { fixture: Fixture; props: TombstoneRestoreProps }) {
  return (
    <StashUiProvider client={fixture.client}>
      <TombstoneRestore {...props} />
    </StashUiProvider>
  );
}

function version(overrides: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: 1,
    kind: "put",
    hash: `sha256-${"a".repeat(64)}`,
    size: 4,
    rollbackOf: null,
    author: "fixture",
    message: "live",
    meta: {},
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("TombstoneRestore", () => {
  it("opens the existing rollback dialog on the newest live version and restores through the fake", async () => {
    const fixture = await makeFixture();
    const tombstone = await fixture.seedTombstone(PATH);
    const onChanged = vi.fn<(success: RollbackSuccess) => void>();
    const versions = [
      tombstone.versions.find((item) => item.version === 1)!,
      tombstone.versions.find((item) => item.kind === "delete")!,
      tombstone.versions.find((item) => item.version === 2)!,
    ];
    renderRestore(fixture, { ...tombstone, versions }, { onChanged });
    const user = userEvent.setup();

    const restore = await screen.findByRole("button", { name: "Restore v2…" });
    expect(restore.closest(".zhs-tombstone-restore")).toBeTruthy();
    await user.click(restore);
    const dialog = await screen.findByRole("dialog", { name: `Rollback ${PATH} to v2` });
    expect(dialog.className).toContain("zhs-rollback-dialog");
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await user.click(confirm);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onChanged.mock.calls[0]?.[0].result).toMatchObject({
      version: 4,
      rollbackOf: 2,
    });
    const history = await fixture.client.files(STASH).history(PATH);
    expect(history.ok && history.value.versions[0]).toMatchObject({
      version: 4,
      kind: "rollback",
      rollbackOf: 2,
    });
  });

  it("does not render for a live head or when no earlier live version is available", async () => {
    const fixture = await makeFixture();
    const tombstone = await fixture.seedTombstone(PATH, ["only\n"]);
    const view = renderRestore(fixture, tombstone, {
      head: { version: 2, deleted: false },
    });
    await waitFor(() => expect(fixture.fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();

    view.rerender(
      <StashUiProvider client={fixture.client}>
        <TombstoneRestore
          head={{ version: 1, deleted: true }}
          path={PATH}
          stash={STASH}
          versions={[version({ version: 1, kind: "delete", hash: null, size: 0 })]}
          onChanged={vi.fn()}
        />
      </StashUiProvider>,
    );
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  it("invalidates an in-flight rollback when the tombstone target changes", async () => {
    const fixture = await makeFixture();
    const first = await fixture.seedTombstone(PATH, ["first\n"]);
    const second = await fixture.seedTombstone(OTHER_PATH, ["other\n"]);
    const releaseRollback = fixture.deferNextRollback();
    const onChanged = vi.fn<(success: RollbackSuccess) => void>();
    const firstProps: TombstoneRestoreProps = {
      stash: STASH,
      path: PATH,
      head: first.head,
      versions: first.versions,
      onChanged,
    };
    const view = render(<RestoreHost fixture={fixture} props={firstProps} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restore v1…" }));
    const confirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    fireEvent.submit(confirm.closest("form")!);
    await waitFor(() => expect(fixture.rollbackPaths).toEqual([PATH]));

    view.rerender(
      <RestoreHost
        fixture={fixture}
        props={{ ...firstProps, path: OTHER_PATH, head: second.head, versions: second.versions }}
      />,
    );
    expect(await screen.findByRole("button", { name: "Restore v1…" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => releaseRollback());
    await waitFor(async () => {
      const history = await fixture.client.files(STASH).history(PATH);
      expect(history.ok && history.value.headVersion).toBe(3);
    });
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restore v1…" }));
    const nextConfirm = await screen.findByRole("button", { name: "Confirm rollback" });
    await waitFor(() => expect(nextConfirm.hasAttribute("disabled")).toBe(false));
    await user.click(nextConfirm);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fixture.rollbackPaths).toEqual([PATH, OTHER_PATH]);
  });

  it("renders nothing and makes no data call beyond /me for a read principal", async () => {
    const adminToken = "restore-denied-admin";
    const fake = createFakeStash({ adminToken });
    fake.createStash(STASH);
    const readToken = await fake.mintToken(STASH, "read");
    const fetch = vi.fn<StashFetch>(fake.fetch);
    const client = createStashClient({ baseUrl: BASE_URL, token: readToken, fetch });
    const onChanged = vi.fn();
    render(
      <StashUiProvider client={client}>
        <TombstoneRestore
          head={{ version: 2, deleted: true }}
          path={PATH}
          stash={STASH}
          versions={[version()]}
          onChanged={onChanged}
        />
      </StashUiProvider>,
    );

    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    const request = new Request(fetch.mock.calls[0]![0], fetch.mock.calls[0]![1]);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/v1/me");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
