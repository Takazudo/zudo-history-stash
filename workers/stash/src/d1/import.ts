import {
  ImportBody,
  canonicalJson,
  sha256Hex,
  utf8ByteLength,
  validateStashName,
  type ApiError,
  type Current,
  type ImportResult,
  type Result,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "../env.js";
import { prepareBlob, type BlobGenerationFactory, type PreparedBlob } from "./blobs.js";
import { importBatch, type PreparedImportVersion } from "./sql/import.js";
import { selectHeadForWrite } from "./sql/writes.js";
import type { StoreDependencies } from "./store.js";
import { mintCommitId, SELECT_COMMIT_VERSIONS } from "./sql/commits.js";

interface HeadForImportRow {
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
  kind: "put" | "delete" | "rollback";
  author: string;
  created_at: number;
}

interface ImportTargetRow {
  version: number;
  blob_hash: string | null;
  size_bytes: number;
}

interface ImportPutFact {
  body: string;
  hash: string;
  size: number;
}

interface LogicalImportBase {
  version: number;
  size: number;
  author: string;
  message: string;
  metaJson: string;
  createdAt: number;
}

type LogicalImportVersion =
  | (LogicalImportBase & {
      kind: "put";
      hash: string;
      rollbackOf: null;
    })
  | (LogicalImportBase & {
      kind: "delete";
      body: null;
      hash: null;
      rollbackOf: null;
    })
  | (LogicalImportBase & {
      kind: "rollback";
      body: null;
      hash: string;
      rollbackOf: number;
    });

export type StoreImportResult =
  | (Extract<Result<ImportResult>, { ok: true }> & {
      statusCode: 201;
      createdVersions: ImportedVersionFact[];
    })
  | Extract<Result<ImportResult>, { ok: false }>;

export interface ImportedVersionFact {
  changeId: number;
  version: number;
  kind: "put" | "delete" | "rollback";
  author: string;
  message: string;
  size: number;
  createdAt: string;
}

export interface StashImport {
  importFile(stash: string, input: ImportBody): Promise<StoreImportResult>;
}

export interface ImportDependencies extends StoreDependencies {
  createdBy?: string;
  onBeforeCommit?: () => void | Promise<void>;
  createBlobGeneration?: BlobGenerationFactory;
}

function failure(
  code: ApiError["code"],
  status: number,
  message: string,
  current?: Current,
): StoreImportResult {
  return { ok: false, error: { code, status, message }, ...(current ? { current } : {}) };
}

function currentFromHead(row: HeadForImportRow): Current {
  return {
    version: row.head_version,
    hash: row.head_hash,
    deleted: row.deleted === 1,
    kind: row.kind,
    author: row.author,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function readHead(
  db: D1DatabaseSession,
  stash: string,
  path: string,
): Promise<HeadForImportRow | null> {
  return db.prepare(selectHeadForWrite).bind(stash, path).first<HeadForImportRow>();
}

async function readExistingTargets(
  db: D1DatabaseSession,
  stash: string,
  path: string,
  versions: number[],
): Promise<Map<number, ImportTargetRow>> {
  if (versions.length === 0) return new Map();
  const placeholders = versions.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT version, blob_hash, size_bytes FROM versions
       WHERE stash_name = ? AND path = ? AND version IN (${placeholders})`,
    )
    .bind(stash, path, ...versions)
    .all<ImportTargetRow>();
  return new Map(rows.results.map((row) => [row.version, row]));
}

async function stashIsLive(db: D1DatabaseSession, stash: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL")
      .bind(stash)
      .first()) !== null
  );
}

function refusal(expectedVersion: number | null, head: HeadForImportRow | null): StoreImportResult {
  if (expectedVersion === null) {
    return head
      ? failure("exists", 409, "File already exists", currentFromHead(head))
      : failure("internal", 500, "Import batch failed without a competing write");
  }
  if (!head) return failure("not-found", 404, "File not found");
  if (head.head_version === expectedVersion) {
    return failure("internal", 500, "Import batch failed without a competing write");
  }
  return failure("stale", 409, "Expected version is stale", currentFromHead(head));
}

export function createImport(env: Env, deps: ImportDependencies): StashImport {
  async function importFile(stash: string, input: ImportBody): Promise<StoreImportResult> {
    const stashValidation = validateStashName(stash);
    if (!stashValidation.ok) return failure("validation", 400, stashValidation.message);
    const parsed = ImportBody.safeParse(input);
    if (!parsed.success) return failure("validation", 400, "Invalid import input");
    const value = parsed.data;
    const operationNow = deps.now();
    if (value.versions.some((entry) => entry.createdAt > operationNow)) {
      return failure("validation", 400, "Import createdAt cannot be in the future");
    }

    const putFacts: (ImportPutFact | undefined)[] = new Array(value.versions.length);
    const distinctPuts = new Map<string, ImportPutFact>();
    for (const [index, entry] of value.versions.entries()) {
      if (entry.kind !== "put") continue;
      const fact = {
        body: entry.body,
        hash: await sha256Hex(entry.body),
        size: utf8ByteLength(entry.body),
      };
      putFacts[index] = fact;
      if (!distinctPuts.has(fact.hash)) distinctPuts.set(fact.hash, fact);
    }

    const db = env.DB.withSession("first-primary");
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    const head = await readHead(db, stash, value.path);
    if (value.expectedVersion === null) {
      if (head) return failure("exists", 409, "File already exists", currentFromHead(head));
    } else if (!head) {
      return failure("not-found", 404, "File not found");
    } else if (head.head_version !== value.expectedVersion) {
      return failure("stale", 409, "Expected version is stale", currentFromHead(head));
    }
    const firstImportedVersion = value.versions[0];
    if (head && firstImportedVersion && firstImportedVersion.createdAt < head.created_at) {
      return failure("validation", 400, "Import createdAt cannot precede the current head");
    }

    const baseVersion = value.expectedVersion ?? 0;
    const storedTargetVersions = Array.from(
      new Set(
        value.versions.flatMap((entry) =>
          entry.kind === "rollback" && entry.rollbackOf <= baseVersion ? [entry.rollbackOf] : [],
        ),
      ),
    );
    const storedTargets = await readExistingTargets(db, stash, value.path, storedTargetVersions);
    for (const targetVersion of storedTargetVersions) {
      const target = storedTargets.get(targetVersion);
      if (!target) return failure("validation", 400, "Import rollback target does not exist");
      if (target.blob_hash === null) {
        return failure("validation", 400, "Import rollback target is a tombstone");
      }
    }

    const logical: LogicalImportVersion[] = [];
    for (const [index, entry] of value.versions.entries()) {
      const version = baseVersion + index + 1;
      if (entry.kind === "put") {
        const fact = putFacts[index];
        if (fact === undefined) throw new Error("Missing import PUT facts");
        logical.push({
          version,
          kind: "put",
          hash: fact.hash,
          size: fact.size,
          rollbackOf: null,
          author: entry.author ?? "",
          message: entry.message ?? "",
          metaJson: canonicalJson(entry.meta ?? {}),
          createdAt: entry.createdAt,
        });
      } else if (entry.kind === "delete") {
        logical.push({
          version,
          kind: "delete",
          body: null,
          hash: null,
          size: 0,
          rollbackOf: null,
          author: entry.author ?? "",
          message: entry.message ?? "",
          metaJson: canonicalJson(entry.meta ?? {}),
          createdAt: entry.createdAt,
        });
      } else {
        const importedTargetIndex = entry.rollbackOf - baseVersion - 1;
        const importedTarget = importedTargetIndex >= 0 ? logical[importedTargetIndex] : undefined;
        const storedTarget = storedTargets.get(entry.rollbackOf);
        const hash = importedTarget?.hash ?? storedTarget?.blob_hash ?? null;
        const size = importedTarget?.size ?? storedTarget?.size_bytes;
        if (hash === null || size === undefined) {
          return failure("validation", 400, "Invalid import rollback target");
        }
        logical.push({
          version,
          kind: "rollback",
          body: null,
          hash,
          size,
          rollbackOf: entry.rollbackOf,
          author: entry.author ?? "",
          message: entry.message ?? "",
          metaJson: canonicalJson(entry.meta ?? {}),
          createdAt: entry.createdAt,
        });
      }
    }

    const storageByHash = new Map<string, PreparedBlob>();
    for (const [hash, fact] of distinctPuts) {
      storageByHash.set(
        hash,
        await prepareBlob(env, stash, hash, fact.body, deps.createBlobGeneration),
      );
    }

    const prepared = logical.map((entry): PreparedImportVersion => {
      if (entry.kind !== "put") return entry;
      const storage = storageByHash.get(entry.hash);
      if (storage === undefined) throw new Error("Missing prepared import blob");
      return { ...entry, ...storage };
    });

    await deps.onBeforeCommit?.();
    const commitCreatedAt = deps.now();
    const commitId = mintCommitId(commitCreatedAt, deps.createId);
    const batch = importBatch(db, {
      commitId,
      createdBy: deps.createdBy ?? "system",
      createdAt: commitCreatedAt,
      stash,
      path: value.path,
      expectedVersion: value.expectedVersion,
      versions: prepared,
    });
    try {
      const results = await db.batch(batch.statements);
      if (results.at(-1)?.meta.changes === 1) {
        const committedRows = await db
          .prepare(SELECT_COMMIT_VERSIONS)
          .bind(stash, commitId)
          .all<{ id: number; path: string; version: number; kind: "put" | "delete" | "rollback" }>();
        const createdVersions = logical.map((entry, index): ImportedVersionFact | null => {
          const committed = committedRows.results[index];
          if (
            committed === undefined ||
            committed.path !== value.path ||
            committed.version !== entry.version ||
            committed.kind !== entry.kind
          ) return null;
          return {
            changeId: committed.id,
            version: entry.version,
            kind: entry.kind,
            author: entry.author,
            message: entry.message,
            size: entry.size,
            createdAt: new Date(entry.createdAt).toISOString(),
          };
        });
        if (createdVersions.some((entry) => entry === null)) {
          return failure("internal", 500, "Missing import change id");
        }
        const exactCreatedVersions = createdVersions.filter(
          (entry): entry is ImportedVersionFact => entry !== null,
        );
        const firstChangeId = exactCreatedVersions[0]?.changeId;
        if (firstChangeId === undefined)
          return failure("internal", 500, "Missing import change id");
        return {
          ok: true,
          statusCode: 201,
          createdVersions: exactCreatedVersions,
          value: {
            commitId,
            path: value.path,
            headVersion: prepared.at(-1)?.version ?? baseVersion,
            firstChangeId,
          },
        };
      }
    } catch {
      // A competing fenced writer can win after the preflight read.
    }
    if (!(await stashIsLive(db, stash))) return failure("not-found", 404, "Stash not found");
    return refusal(value.expectedVersion, await readHead(db, stash, value.path));
  }

  return { importFile };
}
