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
import { importBatch, type PreparedImportVersion } from "./sql/import.js";
import { selectHeadForWrite } from "./sql/writes.js";
import type { StoreDependencies } from "./store.js";

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
}

export type StoreImportResult =
  | (Extract<Result<ImportResult>, { ok: true }> & { statusCode: 201 })
  | Extract<Result<ImportResult>, { ok: false }>;

export interface StashImport {
  importFile(stash: string, input: ImportBody): Promise<StoreImportResult>;
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
      `SELECT version, blob_hash FROM versions
       WHERE stash_name = ? AND path = ? AND version IN (${placeholders})`,
    )
    .bind(stash, path, ...versions)
    .all<ImportTargetRow>();
  return new Map(rows.results.map((row) => [row.version, row]));
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

export function createImport(env: Env, deps: StoreDependencies): StashImport {
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

    const db = env.DB.withSession("first-primary");
    const head = await readHead(db, stash, value.path);
    if (value.expectedVersion === null) {
      if (head) return failure("exists", 409, "File already exists", currentFromHead(head));
    } else if (!head) {
      return failure("not-found", 404, "File not found");
    } else if (head.head_version !== value.expectedVersion) {
      return failure("stale", 409, "Expected version is stale", currentFromHead(head));
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

    const prepared: PreparedImportVersion[] = [];
    for (const [index, entry] of value.versions.entries()) {
      const version = baseVersion + index + 1;
      if (entry.kind === "put") {
        prepared.push({
          version,
          kind: "put",
          body: entry.body,
          hash: await sha256Hex(entry.body),
          size: utf8ByteLength(entry.body),
          rollbackOf: null,
          author: entry.author ?? "",
          message: entry.message ?? "",
          metaJson: canonicalJson(entry.meta ?? {}),
          createdAt: entry.createdAt,
        });
      } else if (entry.kind === "delete") {
        prepared.push({
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
        const importedTarget = importedTargetIndex >= 0 ? prepared[importedTargetIndex] : undefined;
        const storedTarget = storedTargets.get(entry.rollbackOf);
        const hash = importedTarget?.hash ?? storedTarget?.blob_hash ?? null;
        const size = importedTarget?.size ?? 0;
        if (hash === null) return failure("validation", 400, "Invalid import rollback target");
        prepared.push({
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

    const batch = importBatch(db, {
      stash,
      path: value.path,
      expectedVersion: value.expectedVersion,
      versions: prepared,
    });
    try {
      const results = await db.batch(batch.statements);
      if (results.at(-1)?.meta.changes === 1) {
        const firstChangeId = results[batch.firstVersionStatementIndex]?.meta.last_row_id;
        if (typeof firstChangeId !== "number" || firstChangeId < 1) {
          return failure("internal", 500, "Missing import change id");
        }
        return {
          ok: true,
          statusCode: 201,
          value: {
            path: value.path,
            headVersion: prepared.at(-1)?.version ?? baseVersion,
            firstChangeId,
          },
        };
      }
    } catch {
      // A competing fenced writer can win after the preflight read.
    }
    return refusal(value.expectedVersion, await readHead(db, stash, value.path));
  }

  return { importFile };
}
