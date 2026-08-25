import {
  createStashClient,
  type ChangeItem,
  type ClientResult,
  type FileListResponse,
  type ListChangesResult,
  type ListStashesResult,
  type MeResponse,
  type StashClient,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";

export interface FakeViewerClientOverrides {
  me?: ViewerStashClient["me"];
  stashes?: Partial<StashClient["stashes"]>;
  changes?: StashClient["changes"];
  files?: (stash: string) => StashFilesClient;
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
  } as ViewerStashClient;
  client.withSignal = () => client;
  return client;
}
