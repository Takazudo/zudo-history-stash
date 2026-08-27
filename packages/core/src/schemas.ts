import { z } from "zod";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_AUTHOR_BYTES,
  MAX_BODY_BYTES,
  MAX_IMPORT_VERSIONS,
  MAX_MESSAGE_BYTES,
  MAX_META_BYTES,
} from "./limits.js";
import { isWellFormedString, utf8ByteLength } from "./hash.js";
import { validatePath, validateStashName } from "./paths.js";

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
const author = boundedString(MAX_AUTHOR_BYTES).optional();
const message = boundedString(MAX_MESSAGE_BYTES).optional();
const meta = z
  .record(z.string(), z.json())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= MAX_META_BYTES, "Meta is too large")
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
});
export const ChangesQuery = z
  .strictObject({ since: optionalQueryInteger(0), before: optionalQueryInteger(1), limit })
  .refine((value) => value.since === undefined || value.before === undefined, {
    message: "since and before are mutually exclusive",
  });
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
  kind: z.enum(["r2-orphans", "ledger"]),
  dryRun: z.boolean().default(false),
  maxObjects: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export const ListGcRunsQuery = z.strictObject({
  kind: z.enum(["r2-orphans", "ledger"]).optional(),
  limit,
});

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
export type ChangesQuery = z.infer<typeof ChangesQuery>;
export type FileGetQuery = z.infer<typeof FileGetQuery>;
export type HistoryQuery = z.infer<typeof HistoryQuery>;
export type RunGcBody = z.input<typeof RunGcBody>;
export type ListGcRunsQuery = z.input<typeof ListGcRunsQuery>;
export type ParsedRunGcBody = z.output<typeof RunGcBody>;
export type ParsedListGcRunsQuery = z.output<typeof ListGcRunsQuery>;
