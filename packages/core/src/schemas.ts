import { z } from "zod";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_AUTHOR_BYTES,
  MAX_BODY_BYTES,
  MAX_COMMIT_ENTRIES,
  MAX_IMPORT_VERSIONS,
  MAX_MESSAGE_BYTES,
  MAX_META_BYTES,
} from "./limits.js";
import { isCanonicalBase64 } from "./binary.js";
import { isWellFormedString, utf8ByteLength } from "./hash.js";
import { validatePath, validateStashName } from "./paths.js";
import type { StashEvent } from "./types.js";

export const STASH_CLIENT_ID_HEADER = "X-Stash-Client-Id";
export const STASH_CLIENT_ID_PATTERN = /^[!-~](?:[ -~]{0,62}[!-~])?$/;
export const StashClientIdSchema = z
  .string()
  .regex(
    STASH_CLIENT_ID_PATTERN,
    "Client ID must be 1-64 printable ASCII characters without leading or trailing whitespace",
  );

export function isStashClientId(value: unknown): value is z.infer<typeof StashClientIdSchema> {
  return StashClientIdSchema.safeParse(value).success;
}

const nonEmptyQueryInteger = (minimum: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value),
    z.number().int().min(minimum),
  );
const optionalQueryInteger = (minimum: number) => nonEmptyQueryInteger(minimum).optional();
const limit = optionalQueryInteger(1).pipe(
  z.number().int().max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
);
const wellFormed = z.string().refine(isWellFormedString, "String is not well-formed");
const boundedString = (bytes: number) =>
  wellFormed.refine(
    (value) => utf8ByteLength(value) <= bytes,
    `String exceeds ${bytes} UTF-8 bytes`,
  );
const body = wellFormed.refine(
  (value) => utf8ByteLength(value) <= MAX_BODY_BYTES,
  `Body exceeds ${MAX_BODY_BYTES} UTF-8 bytes`,
);
const expectedVersion = z.number().int().positive().nullable();
const sha256 = z.string().regex(/^sha256-[0-9a-f]{64}$/);
const author = boundedString(MAX_AUTHOR_BYTES).optional();
const message = boundedString(MAX_MESSAGE_BYTES).optional();
const metaObject = z
  .record(z.string(), z.json())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= MAX_META_BYTES, "Meta is too large");
const meta = metaObject.optional();
const commitMeta = metaObject
  .refine(
    (value) =>
      !Object.prototype.hasOwnProperty.call(value, "commitId") &&
      !Object.prototype.hasOwnProperty.call(value, "changeSetId"),
    "meta.commitId and meta.changeSetId are platform-owned",
  )
  .optional();

export const PutFileBody = z.strictObject({
  body,
  expectedVersion,
  author,
  message,
  meta,
  contentType: wellFormed.optional(),
  skipIfUnchanged: z.boolean().optional(),
});

export const DeleteFileBody = z.strictObject({
  expectedVersion: z.number().int().positive(),
  author,
  message,
});
export const RollbackBody = z.strictObject({
  toVersion: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  author,
  message,
  meta,
});
export const CreateStashBody = z.strictObject({
  name: z.string().refine((value) => validateStashName(value).ok, "Invalid stash name"),
  description: wellFormed.optional(),
  meta,
});
const tokenExpirationFields = {
  expiresAt: z.iso.datetime().optional(),
  ttlSeconds: z.number().int().positive().max(315_360_000).optional(),
};
export const CreateTokenBody = z
  .strictObject({
    label: wellFormed.optional(),
    scope: z.enum(["read", "write"]),
    ...tokenExpirationFields,
  })
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && value.ttlSeconds !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["ttlSeconds"],
        message: "expiresAt and ttlSeconds are mutually exclusive",
      });
    }
  });
export const RotateTokenBody = z
  .strictObject({
    graceSeconds: z.number().int().min(0).max(86_400).default(300),
    ...tokenExpirationFields,
  })
  .superRefine((value, context) => {
    if (value.expiresAt !== undefined && value.ttlSeconds !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["ttlSeconds"],
        message: "expiresAt and ttlSeconds are mutually exclusive",
      });
    }
  });

const importCommon = { author, message, meta, createdAt: z.number().int().nonnegative() };
const ImportPut = z.strictObject({
  kind: z.literal("put"),
  body,
  rollbackOf: z.never().optional(),
  ...importCommon,
});
const ImportDelete = z.strictObject({
  kind: z.literal("delete"),
  body: z.null(),
  rollbackOf: z.never().optional(),
  ...importCommon,
});
const ImportRollback = z.strictObject({
  kind: z.literal("rollback"),
  body: z.null(),
  rollbackOf: z.number().int().positive(),
  ...importCommon,
});
export const ImportVersion = z.discriminatedUnion("kind", [
  ImportPut,
  ImportDelete,
  ImportRollback,
]);
export const ImportBody = z
  .strictObject({
    path: z.string().refine((value) => validatePath(value).ok, "Invalid file path"),
    expectedVersion,
    versions: z.array(ImportVersion).min(1).max(MAX_IMPORT_VERSIONS),
  })
  .superRefine((value, context) => {
    let previousCreatedAt = -1;
    const baseVersion = value.expectedVersion ?? 0;
    value.versions.forEach((entry, index) => {
      if (entry.createdAt < previousCreatedAt) {
        context.addIssue({
          code: "custom",
          path: ["versions", index, "createdAt"],
          message: "createdAt must be non-decreasing",
        });
      }
      previousCreatedAt = entry.createdAt;
      if (entry.kind !== "rollback") return;
      const ownVersion = baseVersion + index + 1;
      if (entry.rollbackOf >= ownVersion) {
        context.addIssue({
          code: "custom",
          path: ["versions", index, "rollbackOf"],
          message: "rollbackOf must name an earlier version",
        });
        return;
      }
      const importedTargetIndex = entry.rollbackOf - baseVersion - 1;
      if (importedTargetIndex >= 0 && value.versions[importedTargetIndex]?.kind === "delete") {
        context.addIssue({
          code: "custom",
          path: ["versions", index, "rollbackOf"],
          message: "rollbackOf cannot name a delete version",
        });
      }
    });
  });

export const ListQuery = z.strictObject({ limit, after: z.string().optional() });
export const ListStashesQuery = z.strictObject({
  limit,
  after: z.string().optional(),
  includeDeleted: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(false),
  ),
});
export const ListFilesQuery = z.strictObject({
  includeDeleted: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(false),
  ),
  limit,
  after: z.string().optional(),
  prefix: z.string().optional(),
  delimiter: z.string().optional(),
});
export const ChangesQuery = z
  .strictObject({ since: optionalQueryInteger(0), before: optionalQueryInteger(1), limit })
  .refine((value) => value.since === undefined || value.before === undefined, {
    message: "since and before are mutually exclusive",
  });
export const EventsQuery = z.strictObject({ since: optionalQueryInteger(0) });
export const FileGetQuery = z.strictObject({ version: optionalQueryInteger(1) });
export const HistoryQuery = z.strictObject({ limit, before: optionalQueryInteger(1) });
export const DiffQuery = z.strictObject({
  from: nonEmptyQueryInteger(1),
  to: z.union([nonEmptyQueryInteger(1), z.literal("head")]),
  context: optionalQueryInteger(0),
  maxUnifiedBytes: optionalQueryInteger(0),
});
export const DiffCandidateBody = z.strictObject({
  from: z.union([z.number().int().positive(), z.literal("head")]),
  body,
  context: z.number().int().nonnegative().optional(),
});
export const RunGcBody = z.strictObject({
  kind: z.enum(["r2-orphans", "ledger", "content"]),
  dryRun: z.boolean().default(false),
  maxObjects: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export const ListGcRunsQuery = z.strictObject({
  kind: z.enum(["r2-orphans", "ledger", "content"]).optional(),
  limit,
});
const entryPath = z.string().refine((value) => validatePath(value).ok, "Invalid file path");
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const commitExpectedVersion = positiveInteger.nullable();
const entryCommon = { path: entryPath, expectedVersion: commitExpectedVersion };
const canonicalBase64 = z.string().refine(isCanonicalBase64, "Invalid canonical base64");
export const CommitEntryInput = z.union([
  z.strictObject({
    op: z.literal("put"),
    ...entryCommon,
    body,
    contentType: wellFormed.optional(),
  }),
  z.strictObject({
    op: z.literal("put"),
    ...entryCommon,
    representation: z.literal("binary"),
    contentType: wellFormed,
    bytesBase64: canonicalBase64,
  }),
  z.strictObject({
    op: z.literal("copy"),
    ...entryCommon,
    from: z.strictObject({ path: entryPath, version: positiveInteger }),
  }),
  z.strictObject({ op: z.literal("delete"), path: entryPath, expectedVersion: positiveInteger }),
  z.strictObject({
    op: z.literal("rollback"),
    path: entryPath,
    expectedVersion: positiveInteger,
    toVersion: positiveInteger,
  }),
]);

const entryListRefinement = <T extends { path: string; op: string }>(
  value: { entries: T[] },
  context: z.RefinementCtx,
) => {
  const paths = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (paths.has(entry.path)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "path"],
        message: "Entry paths must be unique",
      });
    }
    paths.add(entry.path);
  });
  value.entries.forEach((entry, index) => {
    if (
      entry.op === "copy" &&
      "from" in entry &&
      paths.has((entry as { from: { path: string } }).from.path)
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "from", "path"],
        message: "copy.from.path cannot name another entry path",
      });
    }
  });
};

export const CreateCommitBody = z
  .strictObject({
    entries: z.array(CommitEntryInput).min(1).max(MAX_COMMIT_ENTRIES),
    author,
    message,
    meta: commitMeta,
    expectedLastChangeId: nonNegativeInteger.optional(),
    expectedLastChangePrefix: z.string().optional(),
  })
  .superRefine(entryListRefinement)
  .superRefine((value, context) => {
    if (value.expectedLastChangePrefix !== undefined && value.expectedLastChangeId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedLastChangePrefix"],
        message: "expectedLastChangePrefix requires expectedLastChangeId",
      });
    }
  });
export const RevertCommitBody = z.strictObject({ author, message, meta: commitMeta });
export const ListCommitsQuery = z.strictObject({
  limit,
  after: z.string().optional(),
  path: entryPath.optional(),
});
export const CommitDiffQuery = z.strictObject({
  context: optionalQueryInteger(0),
  path: entryPath.optional(),
  from: z
    .string()
    .regex(/^commit:.+$/)
    .optional(),
  prefix: z.string().optional(),
});
export const SnapshotQuery = z.strictObject({
  at: z.string().regex(/^(commit:.+|change:(0|[1-9][0-9]*))$/),
  prefix: z.string().optional(),
  delimiter: z.string().optional(),
  includeDeleted: z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().default(false),
  ),
  limit,
  after: z.string().optional(),
});

export type SnapshotSelector =
  { kind: "commit"; commitId: string } | { kind: "change"; changeId: number };

export function parseSnapshotSelector(at: string): SnapshotSelector | null {
  const match = /^(commit:.+|change:(0|[1-9][0-9]*))$/.exec(at);
  if (match === null) return null;

  if (at.startsWith("change:")) {
    const changeId = Number(at.slice("change:".length));
    return Number.isSafeInteger(changeId) ? { kind: "change", changeId } : null;
  }

  return { kind: "commit", commitId: at.slice("commit:".length) };
}

const changeSetCommon = { path: entryPath, baseVersion: commitExpectedVersion };
export const ChangeSetEntryInput = z.union([
  z.strictObject({
    op: z.literal("put"),
    ...changeSetCommon,
    body,
    contentType: wellFormed.optional(),
  }),
  z.strictObject({
    op: z.literal("put"),
    ...changeSetCommon,
    representation: z.literal("binary"),
    contentType: wellFormed,
    bytesBase64: canonicalBase64,
  }),
  z.strictObject({
    op: z.literal("copy"),
    ...changeSetCommon,
    from: z.strictObject({ path: entryPath, version: positiveInteger }),
  }),
  z.strictObject({ op: z.literal("delete"), path: entryPath, baseVersion: positiveInteger }),
  z.strictObject({
    op: z.literal("rollback"),
    path: entryPath,
    baseVersion: positiveInteger,
    toVersion: positiveInteger,
  }),
]);
export const CreateChangeSetBody = z
  .strictObject({
    entries: z.array(ChangeSetEntryInput).min(1).max(MAX_COMMIT_ENTRIES),
    author,
    message,
    meta: commitMeta,
    expiresAt: z.iso.datetime().optional(),
    expectedLastChangeId: nonNegativeInteger.optional(),
    expectedLastChangePrefix: z.string().optional(),
  })
  .superRefine(entryListRefinement)
  .superRefine((value, context) => {
    if (value.expectedLastChangePrefix !== undefined && value.expectedLastChangeId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedLastChangePrefix"],
        message: "expectedLastChangePrefix requires expectedLastChangeId",
      });
    }
  });
export const ApproveChangeSetBody = z.strictObject({ author, message });
export const RejectChangeSetBody = z.strictObject({
  reason: boundedString(MAX_MESSAGE_BYTES).optional(),
});
export const ListChangeSetsQuery = z.strictObject({
  status: z.enum(["open", "applied", "rejected", "expired", "all"]).default("open"),
  path: entryPath.optional(),
  limit,
  after: z.string().optional(),
});
export const ChangeSetDiffQuery = z.strictObject({
  context: optionalQueryInteger(0),
  path: entryPath.optional(),
});

/** Metadata-only creation request; content bytes always travel on a raw upload route. */
export const CreateUploadSessionBody = z.strictObject({
  expectedVersion,
  size: z.number().int().nonnegative(),
  hash: sha256.optional(),
  representation: z.enum(["text", "binary"]),
  contentType: boundedString(1_024),
  mode: z.enum(["auto", "single", "multipart"]).default("auto"),
  resumable: z.boolean().default(false),
  skipIfUnchanged: z.boolean().default(false),
});

export const CompleteUploadSessionBody = z.strictObject({
  generation: z.number().int().nonnegative(),
});

export const AbortUploadSessionBody = z.strictObject({
  generation: z.number().int().nonnegative(),
});

export const UploadPartQuery = z.strictObject({
  generation: nonEmptyQueryInteger(0),
});

export const RawContentQuery = z.strictObject({
  version: optionalQueryInteger(1),
});

export const StashReadyEventSchema = z.strictObject({
  type: z.literal("ready"),
  head: z.number().int().nonnegative().nullable(),
  checkpoint: z.number().int().nonnegative().nullable(),
});
export const StashChangeEventSchema = z.strictObject({
  type: z.literal("change"),
  changeId: z.number().int().nonnegative(),
  commitId: z.string(),
  stash: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative(),
  kind: z.enum(["put", "delete", "rollback"]),
  origin: StashClientIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export const StashCommitEventSchema = z.strictObject({
  type: z.literal("commit"),
  commitId: z.string(),
  stash: z.string(),
  entryCount: positiveInteger,
  firstChangeId: positiveInteger,
  lastChangeId: positiveInteger,
  origin: StashClientIdSchema.nullable(),
});
export const StashChangeSetEventSchema = z.strictObject({
  type: z.literal("change-set"),
  changeSetId: z.string(),
  stash: z.string(),
  status: z.enum(["open", "applied", "rejected", "expired"]),
  paths: z.array(z.string()),
  origin: StashClientIdSchema.nullable(),
});
export const StashReconnectEventSchema = z.strictObject({
  type: z.literal("reconnect"),
  reason: z.enum(["lifetime", "replay-limit", "shutdown"]),
});
export const StashEventSchema: z.ZodType<StashEvent> = z.discriminatedUnion("type", [
  StashReadyEventSchema,
  StashChangeEventSchema,
  StashCommitEventSchema,
  StashChangeSetEventSchema,
  StashReconnectEventSchema,
]);

export type PutFileBody = z.infer<typeof PutFileBody>;
export type DeleteFileBody = z.infer<typeof DeleteFileBody>;
export type RollbackBody = z.infer<typeof RollbackBody>;
export type ImportBody = z.infer<typeof ImportBody>;
export type ImportVersion = z.infer<typeof ImportVersion>;
export type CreateStashBody = z.infer<typeof CreateStashBody>;
export type CreateTokenBody = z.infer<typeof CreateTokenBody>;
export type RotateTokenBody = z.input<typeof RotateTokenBody>;
export type DiffQuery = z.infer<typeof DiffQuery>;
export type DiffCandidateBody = z.infer<typeof DiffCandidateBody>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ListStashesQuery = z.input<typeof ListStashesQuery>;
export type ParsedListStashesQuery = z.output<typeof ListStashesQuery>;
export type ListFilesQuery = z.infer<typeof ListFilesQuery>;
export type CommitEntryInput = z.infer<typeof CommitEntryInput>;
export type CreateCommitBody = z.infer<typeof CreateCommitBody>;
export type RevertCommitBody = z.infer<typeof RevertCommitBody>;
export type ListCommitsQuery = z.infer<typeof ListCommitsQuery>;
export type CommitDiffQuery = z.infer<typeof CommitDiffQuery>;
export type SnapshotQuery = z.infer<typeof SnapshotQuery>;
export type ChangeSetEntryInput = z.infer<typeof ChangeSetEntryInput>;
export type CreateChangeSetBody = z.infer<typeof CreateChangeSetBody>;
export type ApproveChangeSetBody = z.infer<typeof ApproveChangeSetBody>;
export type RejectChangeSetBody = z.infer<typeof RejectChangeSetBody>;
export type ListChangeSetsQuery = z.infer<typeof ListChangeSetsQuery>;
export type ChangeSetDiffQuery = z.infer<typeof ChangeSetDiffQuery>;
export type ChangesQuery = z.infer<typeof ChangesQuery>;
export type EventsQuery = z.infer<typeof EventsQuery>;
export type FileGetQuery = z.infer<typeof FileGetQuery>;
export type HistoryQuery = z.infer<typeof HistoryQuery>;
export type RunGcBody = z.input<typeof RunGcBody>;
export type ListGcRunsQuery = z.input<typeof ListGcRunsQuery>;
export type ParsedRunGcBody = z.output<typeof RunGcBody>;
export type ParsedListGcRunsQuery = z.output<typeof ListGcRunsQuery>;
export type CreateUploadSessionBody = z.input<typeof CreateUploadSessionBody>;
export type ParsedCreateUploadSessionBody = z.output<typeof CreateUploadSessionBody>;
export type CompleteUploadSessionBody = z.infer<typeof CompleteUploadSessionBody>;
export type AbortUploadSessionBody = z.infer<typeof AbortUploadSessionBody>;
export type UploadPartQuery = z.infer<typeof UploadPartQuery>;
export type RawContentQuery = z.infer<typeof RawContentQuery>;
export type StashClientId = z.infer<typeof StashClientIdSchema>;
