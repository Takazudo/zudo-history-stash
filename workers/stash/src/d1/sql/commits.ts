import type { CommitRow } from "../schema.js";
import type { SqlFragment } from "./writes.js";

type Preparer = Pick<D1DatabaseSession, "prepare">;

export type CommitInsertRow = Omit<
  CommitRow,
  "change_count" | "sealed" | "first_change_id" | "last_change_id"
>;

export function mintCommitId(now: number, createId: () => string): string {
  const timestamp = String(now).padStart(13, "0");
  const randomHex = createId().replace(/[^0-9a-f]/gi, "").slice(0, 8).padEnd(8, "0");
  return `cmt_${timestamp}${randomHex}`;
}

export function commitInsertStatement(
  db: Preparer,
  row: CommitInsertRow,
  fence: SqlFragment,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO commits
        (id, stash_name, source, source_id, author, message, meta_json, entry_count,
         reverts_commit_id, idempotency_key, request_hash, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence.sql}`,
    )
    .bind(
      row.id,
      row.stash_name,
      row.source,
      row.source_id,
      row.author,
      row.message,
      row.meta_json,
      row.entry_count,
      row.reverts_commit_id,
      row.idempotency_key,
      row.request_hash,
      row.created_by,
      row.created_at,
      ...fence.params,
    );
}

export function sealStatement(
  db: Preparer,
  input: { stash: string; id: string; extraPredicate?: SqlFragment },
): D1PreparedStatement {
  const extra = input.extraPredicate;
  return db
    .prepare(
      `UPDATE commits
       SET change_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id),
           first_change_id = (SELECT MIN(id) FROM versions WHERE commit_id = commits.id),
           last_change_id = (SELECT MAX(id) FROM versions WHERE commit_id = commits.id),
           sealed = 1
       WHERE stash_name = ? AND id = ? AND sealed = 0
         AND entry_count = (SELECT COUNT(*) FROM versions WHERE commit_id = commits.id)
         ${extra ? `AND (${extra.sql})` : ""}`,
    )
    .bind(input.stash, input.id, ...(extra?.params ?? []));
}

export const SELECT_COMMIT_VERSIONS = `
  SELECT id, path, version, kind
  FROM versions
  WHERE stash_name = ? AND commit_id = ?
  ORDER BY id
`;
