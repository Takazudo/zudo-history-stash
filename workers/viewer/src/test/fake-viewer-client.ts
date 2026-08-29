import {
  createStashClient,
  type ChangeSetDiffResult,
  type ChangeSetListResponse,
  type ChangeSetRecord,
  type ChangeItem,
  type ClientResult,
  type CommitDiffResult,
  type CommitListResponse,
  type CommitRecord,
  type FileListResponse,
  type ListChangesResult,
  type ListStashesResult,
  type MeResponse,
  type StashChangeSetsClient,
  type StashCommitsClient,
  type StashClient,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import type { FakeStash } from "@takazudo/zudo-history-stash/testing";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";

export interface FakeViewerClientOverrides {
  me?: ViewerStashClient["me"];
  stashes?: Partial<StashClient["stashes"]>;
  changes?: StashClient["changes"];
  files?: (stash: string) => StashFilesClient;
  commits?: (stash: string) => StashCommitsClient;
  changeSets?: (stash: string) => StashChangeSetsClient;
}

const emptyChanges: ListChangesResult = {
  changes: [],
  hasMore: false,
  nextBefore: null,
};

const missingRecord = {
  ok: false as const,
  error: { status: 404, code: "not-found" as const, message: "Record not found." },
};
const emptyCommitDiff: CommitDiffResult = { entries: [], truncated: false };
const emptyChangeSetDiff: ChangeSetDiffResult = {
  entries: [],
  stale: false,
  status: "open",
  truncated: false,
};

export const adminMe: ClientResult<MeResponse> = {
  ok: true,
  value: { principal: "admin" },
};

export function change(overrides: Partial<ChangeItem> = {}): ChangeItem {
  return {
    changeId: 1,
    commitId: "legacy:1",
    stash: "notes",
    path: "docs/readme.txt",
    version: 2,
    kind: "put",
    author: "Ada",
    message: "Update readme",
    size: 120,
    createdAt: "2026-08-25T08:00:00.000Z",
    ...overrides,
  };
}

export function createFakeViewerClient(
  overrides: FakeViewerClientOverrides = {},
): ViewerStashClient {
  const unreachable = createStashClient({
    baseUrl: "/api",
    token: "zhs_test",
    fetch: async () => {
      throw new Error("Unexpected fake client request");
    },
  });
  const defaultFiles = (stash: string): StashFilesClient => ({
    ...unreachable.files(stash),
    list: async (): Promise<ClientResult<FileListResponse>> => ({
      ok: true,
      value: { files: [], nextAfter: null },
    }),
    changes: async (): Promise<ClientResult<ListChangesResult>> => ({
      ok: true,
      value: emptyChanges,
    }),
  });
  const defaultStashes: StashClient["stashes"] = {
    ...unreachable.stashes,
    list: async (): Promise<ClientResult<ListStashesResult>> => ({
      ok: true,
      value: { stashes: [], nextAfter: null },
    }),
  };
  const defaultCommits = (stash: string): StashCommitsClient => ({
    ...unreachable.commits(stash),
    list: async (): Promise<ClientResult<CommitListResponse>> => ({
      ok: true,
      value: { commits: [], nextAfter: null, total: 0 },
    }),
    get: async (): Promise<ClientResult<CommitRecord>> => missingRecord,
    diff: async (): Promise<ClientResult<CommitDiffResult>> => ({
      ok: true,
      value: emptyCommitDiff,
    }),
  });
  const defaultChangeSets = (stash: string): StashChangeSetsClient => ({
    ...unreachable.changeSets(stash),
    list: async (): Promise<ClientResult<ChangeSetListResponse>> => ({
      ok: true,
      value: { changeSets: [], nextAfter: null, total: 0 },
    }),
    get: async (): Promise<ClientResult<ChangeSetRecord>> => missingRecord,
    diff: async (): Promise<ClientResult<ChangeSetDiffResult>> => ({
      ok: true,
      value: emptyChangeSetDiff,
    }),
  });
  const client = {
    ...unreachable,
    me: overrides.me ?? (async () => adminMe),
    stashes: { ...defaultStashes, ...overrides.stashes },
    changes:
      overrides.changes ??
      (async (): Promise<ClientResult<ListChangesResult>> => ({
        ok: true,
        value: emptyChanges,
      })),
    files: overrides.files ?? defaultFiles,
    commits: overrides.commits ?? defaultCommits,
    changeSets: overrides.changeSets ?? defaultChangeSets,
  } as ViewerStashClient;
  client.withSignal = () => client;
  return client;
}

/** Real SDK client backed by the controllable fake, including events and abort-bound recreations. */
export function createFakeBackedViewerClient(
  fake: FakeStash,
  token: string,
  clientId: string,
): ViewerStashClient {
  const create = (signal?: AbortSignal): StashClient =>
    createStashClient({
      baseUrl: "https://fake.invalid",
      token,
      clientId,
      fetch: (input, init) =>
        fake.fetch(input, signal && !init?.signal ? { ...init, signal } : init),
    });
  const client = create();
  return {
    ...client,
    me: ({ signal } = {}) => create(signal).me(),
    withSignal: (signal) => create(signal),
  };
}
