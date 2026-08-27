import {
  ApproveProposalBody,
  CreateProposalBody,
  DIFF_MAX_BYTES,
  IDEMPOTENCY_KEY_MAX_CHARS,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_BODY_BYTES,
  MAX_META_BYTES,
  RejectProposalBody,
  StashError,
  canonicalJson,
  computeDiff,
  isWellFormedString,
  sha256Hex,
  utf8ByteLength,
  validatePath,
  validateStashName,
  type ApproveProposalBody as ApproveProposalInput,
  type ApproveProposalResult,
  type CreateProposalBody as CreateProposalInput,
  type Current,
  type JsonValue,
  type ProposalDiffResult,
  type ProposalListResponse,
  type ProposalRecord,
  type ProposalStatus,
  type ProposalWithBody,
  type RejectProposalBody as RejectProposalInput,
} from "@takazudo/zudo-history-stash-core";
import { z } from "zod";
import type { Env } from "../env.js";
import { assertBlobRowShape, prepareBlob, readBlob, type BlobCodecRow } from "./blobs.js";
import type { ProposalRow } from "./schema.js";
import {
  SELECT_APPLIED_PROPOSAL_VERSION,
  SELECT_PROPOSAL,
  SELECT_PROPOSAL_BASE,
  SELECT_PROPOSAL_BY_KEY,
  SELECT_PROPOSAL_CURRENT,
  approveProposalBatch,
  backfillAppliedChangeId,
  countProposals,
  createProposalBatch,
  rejectProposalStatement,
  selectProposals,
} from "./sql/proposals.js";
import type { StoreDependencies } from "./store.js";

const DAY_MS = 86_400_000;
const DEFAULT_PROPOSAL_TTL_DAYS = 14;
const PROPOSAL_ID = /^prp_\d{13}[0-9a-f]{8}$/;
const HEX = /^[0-9a-f]{8}$/;
const IsoTimestamp = z.iso.datetime();
const DEFAULT_CONTENT_TYPE = "text/plain; charset=utf-8";

interface ProposalReadRow extends ProposalRow {
  blob_body: string | null;
  blob_r2_key: string | null;
  blob_size: number | null;
}

interface ProposalBaseRow {
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  size_bytes: number;
  blob_body: string | null;
  blob_r2_key: string | null;
  blob_size: number | null;
}

interface ProposalCurrentRow {
  head_version: number;
  head_hash: string | null;
  deleted: 0 | 1;
  kind: "put" | "delete" | "rollback";
  author: string;
  created_at: number;
}

interface TotalRow {
  total: number;
}

interface AppliedVersionRow {
  id: number;
  version: number;
  kind: "put" | "delete" | "rollback";
  blob_hash: string | null;
  created_at: number;
}

export interface ProposalCreateOptions {
  idempotencyKey?: string;
}

export interface ProposalCreateResult {
  value: ProposalRecord;
  replayed?: true;
}

export interface ListProposalOptions {
  status?: "open" | "applied" | "rejected" | "expired" | "all";
  path?: string;
  limit?: number;
  after?: string;
}

export interface ProposalDiffOptions {
  context?: number;
}

export interface ProposalDependencies extends StoreDependencies {
  createBlobGeneration?: () => string;
  onBeforeCommit?: () => void | Promise<void>;
}

export interface ProposalStore {
  createProposal(
    stash: string,
    input: CreateProposalInput,
    options?: ProposalCreateOptions,
  ): Promise<ProposalCreateResult>;
  getProposal(stash: string, id: string): Promise<ProposalWithBody | null>;
  listProposals(stash: string, options?: ListProposalOptions): Promise<ProposalListResponse>;
  getProposalDiff(
    stash: string,
    id: string,
    options?: ProposalDiffOptions,
  ): Promise<ProposalDiffResult | null>;
  approveProposal(
    stash: string,
    id: string,
    input: ApproveProposalInput,
    decidedBy: string,
  ): Promise<ApproveProposalResult | null>;
  rejectProposal(
    stash: string,
    id: string,
    input: RejectProposalInput,
    decidedBy: string,
  ): Promise<ProposalRecord | null>;
}

function validation(message: string): never {
  throw new StashError("validation", message);
}

function notFound(): never {
  throw new StashError("not-found", "Stash not found");
}

function internal(message = "Stored proposal content is unavailable or invalid."): never {
  throw new StashError("internal", message);
}

function toIso(value: number): string {
  if (!Number.isSafeInteger(value)) return internal();
  try {
    return new Date(value).toISOString();
  } catch {
    return internal();
  }
}

function parseMeta(value: string): Record<string, JsonValue> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return internal();
    return parsed as Record<string, JsonValue>;
  } catch {
    return internal();
  }
}

function computedStatus(
  row: Pick<ProposalRow, "status" | "expires_at">,
  now: number,
): ProposalStatus {
  return row.status === "open" && row.expires_at <= now ? "expired" : row.status;
}

function mapProposal(row: ProposalRow, now: number): ProposalRecord {
  return {
    id: row.id,
    stash: row.stash_name,
    path: row.path,
    baseVersion: row.base_version,
    author: row.author,
    message: row.message,
    meta: parseMeta(row.meta_json),
    size: row.size_bytes,
    hash: row.blob_hash,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    status: computedStatus(row, now),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
    appliedVersion: row.applied_version,
    appliedChangeId: row.applied_change_id,
  };
}

function proposalBlob(row: ProposalReadRow): BlobCodecRow {
  if (row.blob_size === null || row.blob_size !== row.size_bytes) return internal();
  const blob = {
    hash: row.blob_hash,
    body: row.blob_body,
    r2_key: row.blob_r2_key,
    size_bytes: row.blob_size,
  };
  assertBlobRowShape(blob);
  return blob;
}

function currentFromRow(row: ProposalCurrentRow | null): Current | null {
  if (row === null) return null;
  return {
    version: row.head_version,
    hash: row.head_hash,
    deleted: row.deleted === 1,
    kind: row.kind,
    author: row.author,
    createdAt: toIso(row.created_at),
  };
}

function validateStash(stash: string): string {
  const result = validateStashName(stash);
  if (!result.ok) return validation(result.message);
  return stash;
}

function validateProposalId(id: string): string {
  if (!PROPOSAL_ID.test(id)) return validation("Invalid proposal id");
  return id;
}

function validateIdempotencyKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  if (typeof key !== "string" || key.length < 1 || key.length > IDEMPOTENCY_KEY_MAX_CHARS) {
    return validation("Invalid idempotency key");
  }
  return key;
}

function ttlDays(env: Env): number {
  const source = env.PROPOSAL_TTL_DAYS || String(DEFAULT_PROPOSAL_TTL_DAYS);
  if (!/^[1-9]\d*$/.test(source)) return internal("Invalid PROPOSAL_TTL_DAYS configuration.");
  const days = Number(source);
  if (!Number.isSafeInteger(days) || days * DAY_MS > Number.MAX_SAFE_INTEGER) {
    return internal("Invalid PROPOSAL_TTL_DAYS configuration.");
  }
  return days;
}

function validateCreateInput(input: CreateProposalInput): number | null {
  if (input === null || typeof input !== "object") return validation("Invalid proposal input");
  if (typeof input.body !== "string") return validation("Invalid proposal input");
  if (!isWellFormedString(input.body)) {
    throw new StashError("body-not-well-formed", "Body is not well-formed Unicode");
  }
  if (utf8ByteLength(input.body) > MAX_BODY_BYTES) {
    throw new StashError("payload-too-large", "Body is too large");
  }
  const schemaInput = { ...input, expiresAt: undefined };
  if (!CreateProposalBody.safeParse(schemaInput).success) {
    return validation("Invalid proposal input");
  }
  if (input.expiresAt === undefined) return null;
  if (typeof input.expiresAt !== "string" || !IsoTimestamp.safeParse(input.expiresAt).success) {
    return validation("expiresAt must be an ISO timestamp");
  }
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isSafeInteger(expiresAt)) return validation("expiresAt must be an ISO timestamp");
  return expiresAt;
}

function proposalId(now: number, generated: string): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 9_999_999_999_999) return internal();
  const entropy = generated.replaceAll("-", "").slice(0, 8).toLowerCase();
  if (!HEX.test(entropy)) return internal("Proposal id generator returned invalid entropy.");
  return `prp_${String(now).padStart(13, "0")}${entropy}`;
}

function requestBodyHashInput(input: CreateProposalInput): JsonValue {
  const value: Record<string, JsonValue> = {
    path: input.path,
    body: input.body,
    baseVersion: input.baseVersion,
  };
  if (input.author !== undefined) value.author = input.author;
  if (input.message !== undefined) value.message = input.message;
  if (input.meta !== undefined) value.meta = input.meta;
  if (input.expiresAt !== undefined) value.expiresAt = input.expiresAt;
  return value;
}

async function isLive(db: D1DatabaseSession, stash: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 FROM stashes WHERE name = ? AND deleted_at IS NULL")
      .bind(stash)
      .first()) !== null
  );
}

async function ensureLive(db: D1DatabaseSession, stash: string): Promise<void> {
  if (!(await isLive(db, stash))) return notFound();
}

async function selectProposalById(
  db: D1DatabaseSession,
  stash: string,
  id: string,
): Promise<ProposalReadRow | null> {
  return db.prepare(SELECT_PROPOSAL).bind(stash, id).first<ProposalReadRow>();
}

async function selectProposalByKey(
  db: D1DatabaseSession,
  stash: string,
  key: string,
): Promise<ProposalReadRow | null> {
  return db.prepare(SELECT_PROPOSAL_BY_KEY).bind(stash, key).first<ProposalReadRow>();
}

function replay(row: ProposalReadRow, requestHash: string, now: number): ProposalCreateResult {
  if (row.request_hash !== requestHash) {
    throw new StashError(
      "idempotency-key-reused",
      "Idempotency key was already used for a different proposal",
    );
  }
  return { value: mapProposal(row, now), replayed: true };
}

function encodeCursor(row: Pick<ProposalRow, "created_at" | "id">): string {
  return btoa(`${row.created_at}:${row.id}`);
}

function decodeCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) return validation("Invalid proposal cursor");
  let decoded: string;
  try {
    decoded = atob(value);
    if (btoa(decoded) !== value) return validation("Invalid proposal cursor");
  } catch {
    return validation("Invalid proposal cursor");
  }
  const separator = decoded.indexOf(":");
  if (separator < 1) return validation("Invalid proposal cursor");
  const createdAtText = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!/^\d+$/.test(createdAtText) || !PROPOSAL_ID.test(id)) {
    return validation("Invalid proposal cursor");
  }
  const createdAt = Number(createdAtText);
  if (
    !Number.isSafeInteger(createdAt) ||
    Number(id.slice("prp_".length, "prp_".length + 13)) !== createdAt
  ) {
    return validation("Invalid proposal cursor");
  }
  return { createdAt, id };
}

function validateListOptions(
  options: ListProposalOptions,
): Required<Pick<ListProposalOptions, "status" | "limit">> &
  Pick<ListProposalOptions, "path" | "after"> {
  const status = options.status ?? "open";
  if (!["open", "applied", "rejected", "expired", "all"].includes(status)) {
    return validation("Invalid proposal status");
  }
  const limit = options.limit ?? LIST_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
    return validation(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}.`);
  }
  if (options.path !== undefined) {
    const path = validatePath(options.path);
    if (!path.ok) return validation(path.message);
  }
  return {
    status,
    limit,
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.after !== undefined ? { after: options.after } : {}),
  };
}

function validateDiffOptions(options: ProposalDiffOptions): number | undefined {
  if (options.context === undefined) return undefined;
  if (!Number.isSafeInteger(options.context) || options.context < 0) {
    return validation("context must be a non-negative integer");
  }
  return options.context;
}

function validateDecisionInput(
  schema: typeof ApproveProposalBody | typeof RejectProposalBody,
  input: unknown,
  decidedBy: string,
): void {
  if (!schema.safeParse(input).success) return validation("Invalid proposal decision input");
  if (typeof decidedBy !== "string" || decidedBy.length === 0) {
    return validation("Invalid proposal decision principal");
  }
}

async function appliedResult(
  db: D1DatabaseSession,
  row: ProposalReadRow,
): Promise<ApproveProposalResult> {
  if (row.status !== "applied" || row.applied_version === null || row.decision_attempt === null) {
    return internal("Applied proposal state is incomplete.");
  }
  const version = await db
    .prepare(SELECT_APPLIED_PROPOSAL_VERSION)
    .bind(row.stash_name, row.path, row.applied_version)
    .first<AppliedVersionRow>();
  if (
    version === null ||
    version.version !== row.applied_version ||
    version.kind !== "put" ||
    version.blob_hash === null ||
    version.blob_hash !== row.blob_hash
  ) {
    return internal("Applied proposal version is missing or invalid.");
  }
  if (row.applied_change_id === null) {
    await backfillAppliedChangeId(db, {
      stash: row.stash_name,
      id: row.id,
      attempt: row.decision_attempt,
      changeId: version.id,
    }).run();
  } else if (row.applied_change_id !== version.id) {
    return internal("Applied proposal change id is invalid.");
  }
  return {
    status: "applied",
    appliedVersion: version.version,
    appliedChangeId: version.id,
    hash: version.blob_hash,
    createdAt: toIso(version.created_at),
  };
}

async function approvalOutcome(
  db: D1DatabaseSession,
  stash: string,
  id: string,
  now: number,
): Promise<ApproveProposalResult | null> {
  await ensureLive(db, stash);
  const row = await selectProposalById(db, stash, id);
  if (row === null) return null;
  if (row.status === "applied") return appliedResult(db, row);
  if (row.status === "rejected") {
    throw new StashError("proposal-closed", "Proposal is already rejected");
  }
  if (row.expires_at <= now) {
    throw new StashError("proposal-expired", "Proposal has expired");
  }
  const currentRow = await db
    .prepare(SELECT_PROPOSAL_CURRENT)
    .bind(stash, row.path)
    .first<ProposalCurrentRow>();
  const current = currentFromRow(currentRow);
  if ((current?.version ?? null) !== row.base_version) {
    throw new StashError(
      "stale",
      "Proposal base no longer matches the current head",
      current ?? undefined,
    );
  }
  return internal("Proposal decision failed without a competing mutation.");
}

export function createProposals(env: Env, deps: ProposalDependencies): ProposalStore {
  return {
    async createProposal(stash, input, options = {}) {
      const stashName = validateStash(stash);
      const key = validateIdempotencyKey(options.idempotencyKey);
      const now = deps.now();
      const explicitExpiry = validateCreateInput(input);
      const size = utf8ByteLength(input.body);
      const [hash, requestHash] = await Promise.all([
        sha256Hex(input.body),
        sha256Hex(canonicalJson(requestBodyHashInput(input))),
      ]);
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      if (key !== undefined) {
        const prior = await selectProposalByKey(db, stashName, key);
        if (prior !== null) return replay(prior, requestHash, now);
      }

      if (explicitExpiry !== null && explicitExpiry <= now) {
        return validation("expiresAt must be in the future");
      }
      const expiresAt = explicitExpiry ?? now + ttlDays(env) * DAY_MS;
      if (!Number.isSafeInteger(expiresAt)) return internal();
      const id = proposalId(now, deps.createId());
      const meta = { ...(input.meta ?? {}), proposalId: id };
      const metaJson = canonicalJson(meta);
      if (utf8ByteLength(metaJson) > MAX_META_BYTES) {
        return validation("Stamped proposal meta is too large");
      }

      const prepared = await prepareBlob(
        env,
        stashName,
        hash,
        input.body,
        deps.createBlobGeneration,
      );
      await deps.onBeforeCommit?.();
      try {
        const results = await db.batch(
          createProposalBatch(db, {
            id,
            stash: stashName,
            path: input.path,
            baseVersion: input.baseVersion,
            hash,
            ...prepared,
            size,
            author: input.author ?? "",
            message: input.message ?? "",
            metaJson,
            expiresAt,
            createdAt: now,
            idempotencyKey: key ?? null,
            requestHash: key === undefined ? null : requestHash,
          }),
        );
        if (results.at(-1)?.meta.changes === 1) {
          const created = await selectProposalById(db, stashName, id);
          if (created === null) return internal("Created proposal could not be read.");
          return { value: mapProposal(created, now) };
        }
      } catch {
        // A concurrent same-key batch may own the partial unique index.
      }

      if (!(await isLive(db, stashName))) return notFound();
      if (key !== undefined) {
        const winner = await selectProposalByKey(db, stashName, key);
        if (winner !== null) return replay(winner, requestHash, now);
      }
      return internal("Proposal create failed without a concurrent winner.");
    },

    async getProposal(stash, id) {
      const stashName = validateStash(stash);
      const proposalIdValue = validateProposalId(id);
      const now = deps.now();
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      const row = await selectProposalById(db, stashName, proposalIdValue);
      if (row === null) return null;
      const body = await readBlob(env, proposalBlob(row));
      return { ...mapProposal(row, now), body };
    },

    async listProposals(stash, options = {}) {
      const stashName = validateStash(stash);
      const parsed = validateListOptions(options);
      const after = decodeCursor(parsed.after);
      const now = deps.now();
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      const query = {
        stash: stashName,
        status: parsed.status,
        path: parsed.path ?? null,
        now,
      };
      const [rowsResult, totalRow] = await Promise.all([
        selectProposals(db, { ...query, after, limit: parsed.limit + 1 }).all<ProposalRow>(),
        countProposals(db, query).first<TotalRow>(),
      ]);
      const rows = rowsResult.results;
      const hasMore = rows.length > parsed.limit;
      if (hasMore) rows.pop();
      return {
        proposals: rows.map((row) => mapProposal(row, now)),
        nextAfter: hasMore && rows.at(-1) !== undefined ? encodeCursor(rows.at(-1)!) : null,
        total: totalRow?.total ?? 0,
      };
    },

    async getProposalDiff(stash, id, options = {}) {
      const stashName = validateStash(stash);
      const proposalIdValue = validateProposalId(id);
      const context = validateDiffOptions(options);
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      const proposal = await selectProposalById(db, stashName, proposalIdValue);
      if (proposal === null) return null;

      const [baseRow, currentRow] = await Promise.all([
        proposal.base_version === null
          ? Promise.resolve(null)
          : db
              .prepare(SELECT_PROPOSAL_BASE)
              .bind(stashName, proposal.path, proposal.base_version)
              .first<ProposalBaseRow>(),
        db
          .prepare(SELECT_PROPOSAL_CURRENT)
          .bind(stashName, proposal.path)
          .first<ProposalCurrentRow>(),
      ]);
      if (proposal.base_version !== null && baseRow === null) {
        throw new StashError("not-found", "Proposal base version was not found");
      }

      const base =
        baseRow === null
          ? { version: null, hash: null, deleted: false }
          : {
              version: baseRow.version,
              hash: baseRow.blob_hash,
              deleted: baseRow.kind === "delete",
            };
      const candidate = { hash: proposal.blob_hash, size: proposal.size_bytes };
      const current = currentFromRow(currentRow);
      const stale = (current?.version ?? null) !== proposal.base_version;
      const baseSize = baseRow?.size_bytes ?? 0;
      if (baseSize > DIFF_MAX_BYTES || proposal.size_bytes > DIFF_MAX_BYTES) {
        return { state: "oversized", reason: "bytes", base, candidate, current, stale };
      }

      let fromText = "";
      if (baseRow !== null && baseRow.kind !== "delete") {
        if (
          baseRow.blob_hash === null ||
          baseRow.blob_size === null ||
          baseRow.blob_size !== baseRow.size_bytes
        ) {
          return internal();
        }
        const blob = {
          hash: baseRow.blob_hash,
          body: baseRow.blob_body,
          r2_key: baseRow.blob_r2_key,
          size_bytes: baseRow.blob_size,
        };
        assertBlobRowShape(blob);
        fromText = await readBlob(env, blob);
      }
      const toText = await readBlob(env, proposalBlob(proposal));
      const result = computeDiff({
        fromText,
        toText,
        fromLabel:
          proposal.base_version === null
            ? `a/${proposal.path}@empty`
            : `a/${proposal.path}@v${proposal.base_version}`,
        toLabel: `b/${proposal.path}@${proposal.id}`,
        context,
      });
      return { ...result, base, candidate, current, stale };
    },

    async approveProposal(stash, id, input, decidedBy) {
      const stashName = validateStash(stash);
      const proposalIdValue = validateProposalId(id);
      validateDecisionInput(ApproveProposalBody, input, decidedBy);
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      const proposal = await selectProposalById(db, stashName, proposalIdValue);
      if (proposal === null) return null;
      if (proposal.status === "applied") return appliedResult(db, proposal);
      if (proposal.status === "rejected") {
        throw new StashError("proposal-closed", "Proposal is already rejected");
      }

      await deps.onBeforeCommit?.();
      const decidedAt = deps.now();
      const attempt = deps.createId();
      let results: D1Result[] | undefined;
      try {
        results = await db.batch(
          approveProposalBatch(db, {
            id: proposal.id,
            stash: proposal.stash_name,
            path: proposal.path,
            baseVersion: proposal.base_version,
            hash: proposal.blob_hash,
            size: proposal.size_bytes,
            contentType: DEFAULT_CONTENT_TYPE,
            author: input.author ?? proposal.author,
            message: input.message ?? proposal.message,
            metaJson: proposal.meta_json,
            attempt,
            decidedAt,
            decidedBy,
          }),
        );
      } catch {
        // A competing fenced mutation may have claimed the proposal or moved the head.
      }
      if (results?.at(-1)?.meta.changes === 1) {
        const insertedId = results[1]?.meta.last_row_id;
        if (typeof insertedId === "number" && insertedId > 0) {
          await backfillAppliedChangeId(db, {
            stash: stashName,
            id: proposalIdValue,
            attempt,
            changeId: insertedId,
          }).run();
        }
        const applied = await selectProposalById(db, stashName, proposalIdValue);
        if (applied === null) return internal("Applied proposal could not be read.");
        return appliedResult(db, applied);
      }
      return approvalOutcome(db, stashName, proposalIdValue, decidedAt);
    },

    async rejectProposal(stash, id, input, decidedBy) {
      const stashName = validateStash(stash);
      const proposalIdValue = validateProposalId(id);
      validateDecisionInput(RejectProposalBody, input, decidedBy);
      const db = env.DB.withSession("first-primary");
      await ensureLive(db, stashName);
      const proposal = await selectProposalById(db, stashName, proposalIdValue);
      if (proposal === null) return null;
      if (proposal.status === "applied") {
        throw new StashError("proposal-closed", "Proposal is already applied");
      }
      if (proposal.status === "rejected") return mapProposal(proposal, deps.now());

      await deps.onBeforeCommit?.();
      const decidedAt = deps.now();
      const result = await rejectProposalStatement(db, {
        stash: stashName,
        id: proposalIdValue,
        decidedAt,
        decidedBy,
        reason: input.reason ?? null,
      }).run();
      if (result.meta.changes === 1) {
        const rejected = await selectProposalById(db, stashName, proposalIdValue);
        if (rejected === null) return internal("Rejected proposal could not be read.");
        return mapProposal(rejected, decidedAt);
      }

      await ensureLive(db, stashName);
      const winner = await selectProposalById(db, stashName, proposalIdValue);
      if (winner === null) return null;
      if (winner.status === "rejected") return mapProposal(winner, decidedAt);
      if (winner.status === "applied") {
        throw new StashError("proposal-closed", "Proposal is already applied");
      }
      return internal("Proposal rejection failed without a competing decision.");
    },
  };
}
