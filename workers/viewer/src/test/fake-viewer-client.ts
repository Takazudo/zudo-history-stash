import {
  createStashClient,
  type ChangeItem,
  type ClientResult,
  type FileListResponse,
  type ListChangesResult,
  type ListStashesResult,
  type MeResponse,
  type ProposalListResponse,
  type StashClient,
  type StashFilesClient,
  type StashProposalsClient,
} from "@takazudo/zudo-history-stash";
import type { FakeStash } from "@takazudo/zudo-history-stash/testing";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";

export interface FakeViewerClientOverrides {
  me?: ViewerStashClient["me"];
  stashes?: Partial<StashClient["stashes"]>;
  changes?: StashClient["changes"];
  files?: (stash: string) => StashFilesClient;
  proposals?: (stash: string) => StashProposalsClient;
}

const emptyChanges: ListChangesResult = {
  changes: [],
  hasMore: false,
  nextBefore: null,
};

export const adminMe: ClientResult<MeResponse> = {
  ok: true,
  value: { principal: "admin" },
};

export function change(overrides: Partial<ChangeItem> = {}): ChangeItem {
  return {
    changeId: 1,
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
  const defaultProposals = (stash: string): StashProposalsClient => ({
    ...unreachable.proposals(stash),
    list: async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 0 },
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
    proposals: overrides.proposals ?? defaultProposals,
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
