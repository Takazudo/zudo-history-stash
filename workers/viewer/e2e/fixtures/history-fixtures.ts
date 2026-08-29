import type {
  ChangeItem,
  ChangeSetDiffResult,
  ChangeSetRecord,
  CommitDiffResult,
  CommitRecord,
  Current,
} from "@takazudo/zudo-history-stash";

export const FIXTURE_STASH = "notes";
export const FIXTURE_COMMIT_ID = "cmt_e2e_atomic_01";
export const FIXTURE_CHANGE_SET_ID = "chs_e2e_review_01";
export const FIXTURE_CREATED_AT = "2026-08-25T09:00:00.000Z";
export const FIXTURE_UPDATED_AT = "2026-08-25T10:00:00.000Z";

const HASHES = ["1", "2", "3", "4", "5", "6"];

export function hashFor(index: number, version = 2): string {
  const marker = HASHES[(index + version) % HASHES.length] ?? String(index + 1);
  return `sha256-${marker.repeat(64)}`;
}

export function currentFor(index: number, version = 2, options: Partial<Current> = {}): Current {
  return {
    version,
    hash: hashFor(index, version),
    deleted: false,
    kind: "put",
    author: "fixture-writer",
    createdAt: FIXTURE_UPDATED_AT,
    ...options,
  };
}

export function commitRecord(
  options: Partial<CommitRecord> & { id?: string; entryCount?: number } = {},
): CommitRecord {
  const paths = options.entries?.map(({ path }) => path) ?? [
    "docs/one.md",
    "docs/two.md",
    "docs/three.md",
  ];
  const entries =
    options.entries ??
    paths.map((path, index) => ({
      path,
      op: "put" as const,
      version: 2,
      kind: "put" as const,
      changeId: 100 + index,
      hash: hashFor(index),
      size: 32 + index,
      contentType: "text/markdown",
      representation: "text" as const,
      rollbackOf: null,
    }));
  return {
    id: FIXTURE_COMMIT_ID,
    stash: FIXTURE_STASH,
    source: "api",
    sourceId: null,
    author: "Ada",
    message: "Update three documents atomically",
    meta: { fixture: "playwright" },
    firstChangeId: 100,
    lastChangeId: 100 + entries.length - 1,
    revertsCommitId: null,
    createdBy: "tok_e2e",
    createdAt: FIXTURE_CREATED_AT,
    entries,
    ...options,
    entryCount: options.entryCount ?? entries.length,
  };
}

export function readyDiff(path: string, index: number, fromVersion = 1, toVersion = 2) {
  const oldLine = `old ${path}`;
  const newLine = `new ${path}`;
  return {
    path,
    op: "put" as const,
    from: { version: fromVersion, hash: hashFor(index, fromVersion) },
    to: { version: toVersion, hash: hashFor(index, toVersion) },
    diff: {
      state: "ready" as const,
      unified: [
        `Index: ${path}`,
        "===================================================================",
        `--- a/${path}@v${fromVersion}`,
        `+++ b/${path}@v${toVersion}`,
        "@@ -1,1 +1,1 @@",
        `-${oldLine}`,
        `+${newLine}`,
        "",
      ].join("\n"),
      truncated: false,
      stats: { added: 1, removed: 1 },
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [`-${oldLine}`, `+${newLine}`],
        },
      ],
    },
  } satisfies CommitDiffResult["entries"][number];
}

export function commitDiff(record = commitRecord()): CommitDiffResult {
  return {
    entries: record.entries.map((entry, index) => readyDiff(entry.path, index, 1, entry.version)),
    truncated: false,
  };
}

export function changeItem(index: number, options: Partial<ChangeItem> = {}): ChangeItem {
  const path = options.path ?? `docs/${["one", "two", "three"][index] ?? `item-${index}`}.md`;
  return {
    commitId: FIXTURE_COMMIT_ID,
    changeId: 100 + index,
    stash: FIXTURE_STASH,
    path,
    version: 2,
    kind: "put",
    author: "Ada",
    message: "Atomic update",
    size: 32 + index,
    createdAt: FIXTURE_CREATED_AT,
    representation: "text",
    contentType: "text/markdown",
    ...options,
  };
}

export function changeSetRecord(options: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  const entries = options.entries ?? [
    {
      path: "review/pending.md",
      op: "put" as const,
      baseVersion: null,
      current: null,
      stale: false,
    },
  ];
  return {
    id: FIXTURE_CHANGE_SET_ID,
    stash: FIXTURE_STASH,
    status: "open",
    author: "review-bot",
    message: "Review pending document",
    meta: { fixture: "playwright" },
    expiresAt: "2026-08-26T09:00:00.000Z",
    createdBy: "tok_e2e",
    createdAt: FIXTURE_CREATED_AT,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    commitId: null,
    entries,
    ...options,
  };
}

export function changeSetDiff(
  record = changeSetRecord(),
  options: Partial<ChangeSetDiffResult> = {},
): ChangeSetDiffResult {
  const entries = record.entries.map((entry, index) => {
    const candidate = currentFor(index, 1);
    const diff = {
      state: "ready" as const,
      unified: `Index: ${entry.path}\n@@ -0,0 +1,1 @@\n+pending ${entry.path}\n`,
      truncated: false,
      stats: { added: 1, removed: 0 },
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [`+pending ${entry.path}`],
        },
      ],
    };
    return {
      path: entry.path,
      op: entry.op,
      base: entry.current,
      candidate,
      current: entry.current,
      stale: entry.stale,
      diff,
    };
  });
  return {
    entries,
    stale: entries.some(({ stale }) => stale),
    status: record.status,
    truncated: false,
    ...options,
  };
}

export function fileRecordFor(entry: CommitRecord["entries"][number], index: number) {
  return {
    path: entry.path,
    version: entry.version,
    hash: entry.hash,
    size: entry.size,
    kind: entry.kind,
    author: "Ada",
    message: "Atomic update",
    meta: {},
    createdAt: FIXTURE_UPDATED_AT,
    deleted: false,
    body: `new ${entry.path}\n`,
    representation: "text" as const,
    contentType: "text/markdown",
    byteSize: entry.size,
    etag: `"v${entry.version}-${entry.hash ?? hashFor(index)}"`,
  };
}
