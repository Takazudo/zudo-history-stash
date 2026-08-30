/**
 * Characterizes the pre-collapse single-path write contract.
 *
 * Known accepted collapse delta: commit PUT entries add a stored-blob shape precondition that the
 * current single-path version insert lacks. A pre-existing malformed blob row may therefore be
 * refused after the collapse; that unreachable corruption case is intentionally not pinned here.
 */
import { env } from "cloudflare:workers";
import {
  R2_SPILL_BYTES,
  StashEventSchema,
  canonicalJson,
  requestHashInput,
  sha256Hex,
  type JsonValue,
  type StashEvent,
} from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { app } from "../../../src/app.js";
import type { Env } from "../../../src/env.js";
import { bearer, request } from "../../helpers/app.js";
import { counts, setup } from "./helpers.js";

interface RawVersionRow {
  id: number;
  stash_name: string;
  path: string;
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  size_bytes: number;
  content_type: string;
  rollback_of: number | null;
  author: string;
  message: string;
  meta_json: string;
  created_at: number;
  representation: "text" | "binary";
  application_etag: string | null;
  content_storage: "legacy" | "bytes";
  commit_id: string;
  copied_from_path: string | null;
  copied_from_version: number | null;
}

interface RawCommitRow {
  id: string;
  stash_name: string;
  source: string;
  source_id: string | null;
  author: string;
  message: string;
  meta_json: string;
  entry_count: number;
  change_count: number;
  sealed: 0 | 1;
  first_change_id: number | null;
  last_change_id: number | null;
  reverts_commit_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_by: string;
  created_at: number;
}

interface RawFileRow {
  stash_name: string;
  path: string;
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
  created_at: number;
  updated_at: number;
}

interface RawBlobRow {
  stash_name: string;
  hash: string;
  body: string | null;
  r2_key: string | null;
  size_bytes: number;
  created_at: number;
}

async function versionRow(stash: string, path: string, version: number) {
  return env.DB.prepare("SELECT * FROM versions WHERE stash_name = ? AND path = ? AND version = ?")
    .bind(stash, path, version)
    .first<RawVersionRow>();
}

async function commitRow(stash: string, id: string) {
  return env.DB.prepare("SELECT * FROM commits WHERE stash_name = ? AND id = ?")
    .bind(stash, id)
    .first<RawCommitRow>();
}

async function fileRow(stash: string, path: string) {
  return env.DB.prepare("SELECT * FROM files WHERE stash_name = ? AND path = ?")
    .bind(stash, path)
    .first<RawFileRow>();
}

function recordingEvents(bindings: Env): { bindings: Env; events: StashEvent[] } {
  const events: StashEvent[] = [];
  const namespace = new Proxy(bindings.STASH_EVENTS, {
    get(target, property, receiver) {
      if (property === "getByName") {
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(stubTarget, stubProperty, stubReceiver) {
              if (stubProperty === "fetch") {
                return async (input: Request): Promise<Response> => {
                  events.push(...StashEventSchema.array().parse(await input.json()));
                  return new Response(null, { status: 204 });
                };
              }
              const value = Reflect.get(stubTarget, stubProperty, stubReceiver);
              return typeof value === "function" ? value.bind(stubTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...bindings, STASH_EVENTS: namespace }, events };
}

async function expectedRequestHash(
  operation: "put" | "delete" | "rollback",
  input: Parameters<typeof requestHashInput>[1],
) {
  return sha256Hex(canonicalJson(requestHashInput(operation, input)));
}

describe("single-path write raw-row characterization", () => {
  it("pins every create-put version, blob, and file column", async () => {
    const { stash, writes } = await setup();
    const path = "create.txt";
    const body = "hello row shape";
    const meta = { z: 1, nested: { b: true, a: false }, a: "first" } satisfies Record<
      string,
      JsonValue
    >;
    const result = await writes.put(stash, path, {
      body,
      expectedVersion: null,
      contentType: "text/markdown; charset=utf-8",
      author: "put author",
      message: "put message",
      meta,
    });
    if (!result.ok || "unchanged" in result.value) throw new Error("Expected create put");
    const hash = await sha256Hex(body);
    const createdAt = Date.parse(result.value.createdAt);

    await expect(versionRow(stash, path, 1)).resolves.toEqual({
      id: result.value.changeId,
      stash_name: stash,
      path,
      version: 1,
      kind: "put",
      blob_hash: hash,
      size_bytes: new TextEncoder().encode(body).byteLength,
      content_type: "text/markdown; charset=utf-8",
      rollback_of: null,
      author: "put author",
      message: "put message",
      meta_json: canonicalJson(meta),
      created_at: createdAt,
      representation: "text",
      application_etag: null,
      content_storage: "legacy",
      commit_id: result.value.commitId,
      copied_from_path: null,
      copied_from_version: null,
    });
    await expect(
      env.DB.prepare("SELECT * FROM blobs WHERE stash_name = ? AND hash = ?")
        .bind(stash, hash)
        .first<RawBlobRow>(),
    ).resolves.toEqual({
      stash_name: stash,
      hash,
      body,
      r2_key: null,
      size_bytes: new TextEncoder().encode(body).byteLength,
      created_at: createdAt,
    });
    await expect(fileRow(stash, path)).resolves.toEqual({
      stash_name: stash,
      path,
      head_version: 1,
      head_hash: hash,
      deleted: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });
  });

  it("pins the create-put commit row without permanent idempotency or stamped metadata", async () => {
    const { stash, writes } = await setup();
    const path = "commit.txt";
    const meta = { z: 1, a: { second: 2, first: 1 } } satisfies Record<string, JsonValue>;
    const result = await writes.put(
      stash,
      path,
      {
        body: "committed",
        expectedVersion: null,
        author: "commit author",
        message: "commit message",
        meta,
      },
      { idempotencyKey: "put-row-shape", createdBy: "row-shape-principal" },
    );
    if (!result.ok || "unchanged" in result.value) throw new Error("Expected committed put");

    const row = await commitRow(stash, result.value.commitId);
    expect(row).toEqual({
      id: result.value.commitId,
      stash_name: stash,
      source: "put",
      source_id: null,
      author: "commit author",
      message: "commit message",
      meta_json: canonicalJson(meta),
      entry_count: 1,
      change_count: 1,
      sealed: 1,
      first_change_id: result.value.changeId,
      last_change_id: result.value.changeId,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: null,
      created_by: "row-shape-principal",
      created_at: Date.parse(result.value.createdAt),
    });
    expect(JSON.parse(row?.meta_json ?? "null")).not.toHaveProperty("commitId");
  });

  it("pins put resurrection over a tombstone", async () => {
    const { stash, writes } = await setup();
    const path = "resurrect.txt";
    const first = await writes.put(stash, path, { body: "before", expectedVersion: null });
    if (!first.ok || "unchanged" in first.value) throw new Error("Expected initial put");
    const deleted = await writes.delete(stash, path, { expectedVersion: 1 });
    if (!deleted.ok) throw new Error("Expected delete");
    const resurrected = await writes.put(stash, path, {
      body: "after",
      expectedVersion: 2,
    });
    if (!resurrected.ok || "unchanged" in resurrected.value)
      throw new Error("Expected resurrection");

    await expect(fileRow(stash, path)).resolves.toEqual({
      stash_name: stash,
      path,
      head_version: 3,
      head_hash: await sha256Hex("after"),
      deleted: 0,
      created_at: Date.parse(first.value.createdAt),
      updated_at: Date.parse(resurrected.value.createdAt),
    });
  });

  it("pins delete version, file, and commit rows including SQL metadata defaults", async () => {
    const { stash, writes } = await setup();
    const path = "delete.txt";
    const first = await writes.put(stash, path, {
      body: "delete target",
      expectedVersion: null,
      contentType: "text/markdown",
    });
    if (!first.ok || "unchanged" in first.value) throw new Error("Expected initial put");
    const deleted = await writes.delete(stash, path, {
      expectedVersion: 1,
      author: "delete author",
      message: "delete message",
    });
    if (!deleted.ok) throw new Error("Expected delete");
    const createdAt = Date.parse(deleted.value.createdAt);

    await expect(versionRow(stash, path, 2)).resolves.toEqual({
      id: deleted.value.changeId,
      stash_name: stash,
      path,
      version: 2,
      kind: "delete",
      blob_hash: null,
      size_bytes: 0,
      content_type: "text/markdown",
      rollback_of: null,
      author: "delete author",
      message: "delete message",
      meta_json: "{}",
      created_at: createdAt,
      representation: "text",
      application_etag: null,
      content_storage: "legacy",
      commit_id: deleted.value.commitId,
      copied_from_path: null,
      copied_from_version: null,
    });
    await expect(fileRow(stash, path)).resolves.toEqual({
      stash_name: stash,
      path,
      head_version: 2,
      head_hash: null,
      deleted: 1,
      created_at: Date.parse(first.value.createdAt),
      updated_at: createdAt,
    });
    await expect(commitRow(stash, deleted.value.commitId)).resolves.toEqual({
      id: deleted.value.commitId,
      stash_name: stash,
      source: "delete",
      source_id: null,
      author: "delete author",
      message: "delete message",
      meta_json: "{}",
      entry_count: 1,
      change_count: 1,
      sealed: 1,
      first_change_id: deleted.value.changeId,
      last_change_id: deleted.value.changeId,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: null,
      created_by: "system",
      created_at: createdAt,
    });
  });

  it("pins rollback default-message asymmetry for omitted, empty, and explicit messages", async () => {
    const { stash, writes } = await setup();
    const cases = [
      { path: "omitted.txt", input: {}, versionMessage: "Rollback to v1", commitMessage: "" },
      {
        path: "empty.txt",
        input: { message: "" },
        versionMessage: "Rollback to v1",
        commitMessage: "",
      },
      {
        path: "explicit.txt",
        input: { message: "undo" },
        versionMessage: "undo",
        commitMessage: "undo",
      },
    ] as const;

    for (const current of cases) {
      await writes.put(stash, current.path, { body: "one", expectedVersion: null });
      await writes.put(stash, current.path, { body: "two", expectedVersion: 1 });
      const rolledBack = await writes.rollback(stash, current.path, {
        expectedVersion: 2,
        toVersion: 1,
        ...current.input,
      });
      if (!rolledBack.ok) throw new Error(`Expected rollback for ${current.path}`);
      await expect(
        env.DB.prepare(
          `SELECT v.message AS version_message, c.message AS commit_message
           FROM versions v JOIN commits c ON c.id = v.commit_id
           WHERE v.stash_name = ? AND v.path = ? AND v.version = 3`,
        )
          .bind(stash, current.path)
          .first(),
      ).resolves.toEqual({
        version_message: current.versionMessage,
        commit_message: current.commitMessage,
      });
    }
  });

  it("pins rollback target columns, live head, and commit metadata", async () => {
    const { stash, writes } = await setup();
    const path = "rollback.txt";
    const first = await writes.put(stash, path, {
      body: "target body",
      expectedVersion: null,
      contentType: "text/markdown",
    });
    if (!first.ok || "unchanged" in first.value) throw new Error("Expected rollback target");
    await writes.put(stash, path, {
      body: "later body",
      expectedVersion: 1,
      contentType: "text/plain",
    });
    const meta = { reason: "characterize", nested: { z: 2, a: 1 } } satisfies Record<
      string,
      JsonValue
    >;
    const rolledBack = await writes.rollback(stash, path, {
      expectedVersion: 2,
      toVersion: 1,
      author: "rollback author",
      message: "undo",
      meta,
    });
    if (!rolledBack.ok) throw new Error("Expected rollback");
    const createdAt = Date.parse(rolledBack.value.createdAt);

    await expect(versionRow(stash, path, 3)).resolves.toEqual({
      id: rolledBack.value.changeId,
      stash_name: stash,
      path,
      version: 3,
      kind: "rollback",
      blob_hash: first.value.hash,
      size_bytes: new TextEncoder().encode("target body").byteLength,
      content_type: "text/markdown",
      rollback_of: 1,
      author: "rollback author",
      message: "undo",
      meta_json: canonicalJson(meta),
      created_at: createdAt,
      representation: "text",
      application_etag: null,
      content_storage: "legacy",
      commit_id: rolledBack.value.commitId,
      copied_from_path: null,
      copied_from_version: null,
    });
    await expect(fileRow(stash, path)).resolves.toEqual({
      stash_name: stash,
      path,
      head_version: 3,
      head_hash: first.value.hash,
      deleted: 0,
      created_at: Date.parse(first.value.createdAt),
      updated_at: createdAt,
    });
    await expect(commitRow(stash, rolledBack.value.commitId)).resolves.toEqual({
      id: rolledBack.value.commitId,
      stash_name: stash,
      source: "rollback",
      source_id: null,
      author: "rollback author",
      message: "undo",
      meta_json: canonicalJson(meta),
      entry_count: 1,
      change_count: 1,
      sealed: 1,
      first_change_id: rolledBack.value.changeId,
      last_change_id: rolledBack.value.changeId,
      reverts_commit_id: null,
      idempotency_key: null,
      request_hash: null,
      created_by: "system",
      created_at: createdAt,
    });
  });

  it("pins all operation ledger rows and leaves no rows for a refused idempotent write", async () => {
    const { stash, writes } = await setup();
    const path = "ledger.txt";
    const putInput = {
      body: "ledger body",
      expectedVersion: null,
      author: "put ledger",
      message: "put ledger message",
      meta: { z: 2, a: 1 },
      skipIfUnchanged: true,
    } as const;
    const put = await writes.put(stash, path, putInput, { idempotencyKey: "ledger-put" });
    if (!put.ok || "unchanged" in put.value) throw new Error("Expected ledger put");
    const deleteInput = {
      expectedVersion: 1,
      author: "delete ledger",
      message: "delete ledger message",
    } as const;
    const deleted = await writes.delete(stash, path, deleteInput, {
      idempotencyKey: "ledger-delete",
    });
    if (!deleted.ok) throw new Error("Expected ledger delete");
    const rollbackInput = {
      expectedVersion: 2,
      toVersion: 1,
      author: "rollback ledger",
      message: "rollback ledger message",
      meta: { reason: "ledger" },
    } as const;
    const rolledBack = await writes.rollback(stash, path, rollbackInput, {
      idempotencyKey: "ledger-rollback",
    });
    if (!rolledBack.ok) throw new Error("Expected ledger rollback");
    const bodyHash = await sha256Hex(putInput.body);

    const rows = await env.DB.prepare(
      `SELECT key, request_hash, path, version, status_code
       FROM idempotency WHERE stash_name = ? ORDER BY version`,
    )
      .bind(stash)
      .all<{
        key: string;
        request_hash: string;
        path: string;
        version: number;
        status_code: number;
      }>();
    expect(rows.results).toEqual([
      {
        key: "ledger-put",
        request_hash: await expectedRequestHash("put", {
          path,
          expectedVersion: null,
          bodyHash,
          contentType: "text/plain; charset=utf-8",
          author: putInput.author,
          message: putInput.message,
          meta: putInput.meta,
          skipIfUnchanged: true,
        }),
        path,
        version: 1,
        status_code: 201,
      },
      {
        key: "ledger-delete",
        request_hash: await expectedRequestHash("delete", { path, ...deleteInput }),
        path,
        version: 2,
        status_code: 200,
      },
      {
        key: "ledger-rollback",
        request_hash: await expectedRequestHash("rollback", { path, ...rollbackInput }),
        path,
        version: 3,
        status_code: 201,
      },
    ]);

    const before = await counts(stash);
    const refused = await writes.put(
      stash,
      path,
      { body: "refused unique body", expectedVersion: 99 },
      { idempotencyKey: "refused-ledger" },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "stale", status: 409 } });
    expect(await counts(stash)).toEqual(before);
  });

  it("pins exact store-level refusal bodies with fully populated current values", async () => {
    const { stash, writes } = await setup();
    const path = "refusal.txt";
    const first = await writes.put(stash, path, {
      body: "current body",
      expectedVersion: null,
      author: "current author",
    });
    if (!first.ok || "unchanged" in first.value) throw new Error("Expected refusal fixture");
    const current = {
      version: 1,
      hash: first.value.hash,
      deleted: false,
      kind: "put",
      author: "current author",
      createdAt: first.value.createdAt,
    };

    expect(await writes.put(stash, path, { body: "stale", expectedVersion: 2 })).toEqual({
      ok: false,
      error: { code: "stale", status: 409, message: "Expected version is stale" },
      current,
    });
    expect(await writes.delete(stash, path, { expectedVersion: 2 })).toEqual({
      ok: false,
      error: { code: "stale", status: 409, message: "Expected version is stale" },
      current,
    });
    expect(await writes.rollback(stash, path, { expectedVersion: 2, toVersion: 1 })).toEqual({
      ok: false,
      error: { code: "stale", status: 409, message: "Expected version is stale" },
      current,
    });
    expect(await writes.put(stash, path, { body: "exists", expectedVersion: null })).toEqual({
      ok: false,
      error: { code: "exists", status: 409, message: "File already exists" },
      current,
    });
    expect(await writes.rollback(stash, path, { expectedVersion: 1, toVersion: 99 })).toEqual({
      ok: false,
      error: { code: "version-not-found", status: 404, message: "Version not found" },
      current,
    });

    const tombstonePath = "tombstone.txt";
    await writes.put(stash, tombstonePath, {
      body: "delete me",
      expectedVersion: null,
      author: "original author",
    });
    const deleted = await writes.delete(stash, tombstonePath, {
      expectedVersion: 1,
      author: "delete author",
    });
    if (!deleted.ok) throw new Error("Expected tombstone fixture");
    const tombstoneCurrent = {
      version: 2,
      hash: null,
      deleted: true,
      kind: "delete",
      author: "delete author",
      createdAt: deleted.value.createdAt,
    };
    expect(await writes.delete(stash, tombstonePath, { expectedVersion: 2 })).toEqual({
      ok: false,
      error: { code: "already-deleted", status: 409, message: "File is already deleted" },
      current: tombstoneCurrent,
    });
    expect(
      await writes.rollback(stash, tombstonePath, { expectedVersion: 2, toVersion: 2 }),
    ).toEqual({
      ok: false,
      error: {
        code: "rollback-target-tombstone",
        status: 422,
        message: "Cannot rollback to a tombstone",
      },
      current: tombstoneCurrent,
    });
  });

  it("pins spilled-put blob and version storage columns", async () => {
    const { stash, writes } = await setup();
    const path = "spilled.txt";
    const body = "s".repeat(R2_SPILL_BYTES + 1);
    const hash = await sha256Hex(body);
    const result = await writes.put(stash, path, { body, expectedVersion: null });
    if (!result.ok || "unchanged" in result.value) throw new Error("Expected spilled put");

    const blob = await env.DB.prepare(
      "SELECT stash_name, hash, body, r2_key, size_bytes FROM blobs WHERE stash_name = ? AND hash = ?",
    )
      .bind(stash, hash)
      .first<Omit<RawBlobRow, "created_at">>();
    expect(blob).toEqual({
      stash_name: stash,
      hash,
      body: null,
      r2_key: expect.any(String),
      size_bytes: R2_SPILL_BYTES + 1,
    });
    expect(blob?.r2_key).not.toBe("");
    await expect(
      env.DB.prepare(
        `SELECT representation, application_etag, content_storage, blob_hash
         FROM versions WHERE stash_name = ? AND path = ? AND version = 1`,
      )
        .bind(stash, path)
        .first(),
    ).resolves.toEqual({
      representation: "text",
      application_etag: null,
      content_storage: "legacy",
      blob_hash: hash,
    });
  });

  it("publishes one change event and no commit event for a routed single-path put", async () => {
    const initial = await setup();
    const { bindings, events } = recordingEvents(initial.env);
    const path = "event.txt";
    const response = await request(
      app,
      `http://stash.test/v1/stashes/${initial.stash}/files/${path}`,
      {
        method: "PUT",
        headers: { ...bearer("test-admin"), "Content-Type": "application/json" },
        body: JSON.stringify({ body: "event body", expectedVersion: null }),
      },
      bindings,
    );
    expect(response.status).toBe(201);
    const result = await response.json<{ commitId: string; changeId: number; createdAt: string }>();
    expect(events).toEqual([
      {
        type: "change",
        changeId: result.changeId,
        commitId: result.commitId,
        stash: initial.stash,
        path,
        version: 1,
        kind: "put",
        origin: null,
        createdAt: result.createdAt,
      },
    ]);
    expect(events.some((event) => event.type === "commit")).toBe(false);
  });
});
