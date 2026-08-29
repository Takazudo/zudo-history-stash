import type {
  GcKind,
  GcRunResult,
  CapabilitiesResponse,
  ChangeSetStatus,
  CommitEntryRecord,
  CommitRecord,
  ContentAccess,
  Current,
  JsonValue,
  ReconnectReason,
  RouteId,
  StashEvent,
  TokenScope,
  VersionKind,
  Representation,
  StorageTier,
  UploadMode,
  UploadCompletionResult,
  UploadSessionState,
} from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../transport.js";

export type RateLimitCapability = "read" | "write" | "diff";

export interface FakeRateLimitInput {
  capability: RateLimitCapability;
  key: string;
  routeId: RouteId;
}

export interface FakeRateLimitResult {
  success: boolean;
}

/** A Cloudflare-shaped limiter seam. Rejections deliberately fail open, like the real Worker. */
export type FakeRateLimiter = (
  input: FakeRateLimitInput,
) => FakeRateLimitResult | Promise<FakeRateLimitResult>;

/** Options for the deliberately narrow in-memory History Stash fake. */
export interface FakeStashOptions {
  adminToken?: string;
  now?: () => number;
  rateLimit?: FakeRateLimiter;
  /** Number of days in which a soft-deleted stash can be restored. Defaults to the Worker value. */
  deleteGraceDays?: number;
  /** Minimum age used by the fake orphan collector. Defaults to fifteen minutes. */
  gcOrphanMinAgeMs?: number;
  /** Binary settings advertised by the fake; useful for deterministic mode-selection tests. */
  capabilities?: CapabilitiesResponse;
}

export interface FakeMintTokenOptions {
  label?: string;
  expiresAt?: string;
  ttlSeconds?: number;
}

export interface FakeStashRow {
  name: string;
  description: string;
  meta: Record<string, JsonValue>;
  createdAt: number;
  deletedAt: number | null;
}

export interface FakeTokenRow {
  id: string;
  /** Bare SHA-256 digest; the plaintext secret is never retained in inspectable state. */
  tokenHash: string;
  stash: string;
  label: string;
  scope: TokenScope;
  createdAt: number;
  expiresAt: number | null;
  rotatedFrom: string | null;
  rotatedTo: string | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface FakeBlobRow {
  stash: string;
  hash: string;
  body: string | null;
  /** Exact immutable content bytes, including invalid UTF-8. */
  bytes: Uint8Array;
  /** Exact immutable R2 generation referenced by the logical blob row, or null for inline data. */
  r2Key: string | null;
  size: number;
  createdAt: number;
}

/** Private R2 inventory rows used to exercise orphan collection without deleting D1 blobs. */
export interface FakeR2ObjectRow {
  key: string;
  stash: string;
  hash: string;
  size: number;
  createdAt: number;
}

export interface FakeFileRow {
  stash: string;
  path: string;
  headVersion: number;
  headHash: string | null;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FakeVersionRow {
  changeId: number;
  /** The immutable commit which appended this version. */
  commitId: string;
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  hash: string | null;
  size: number;
  contentType: string;
  representation?: Representation;
  contentAccess?: ContentAccess;
  rollbackOf: number | null;
  copiedFrom?: { path: string; version: number };
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: number;
}

export interface FakeCommitRow extends CommitRecord {
  /** Request fingerprint used to make create/revert replay deterministic. */
  requestHash: string | null;
  idempotencyKey: string | null;
  /** Preserve the original request operation for replay and skipped entries. */
  requestedEntries: Array<CommitEntryRecord["op"]>;
}

export interface FakeChangeSetEntryRow {
  path: string;
  op: CommitEntryRecord["op"];
  baseVersion: number | null;
  /** Candidate content is kept immutable and may be binary. */
  body?: string;
  bytes?: Uint8Array;
  contentType?: string;
  hash?: string | null;
  size?: number;
  representation?: Representation;
  contentAccess?: ContentAccess;
  copiedFrom?: { path: string; version: number };
  toVersion?: number;
}

export interface FakeChangeSetRow {
  id: string;
  stash: string;
  status: ChangeSetStatus;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  expiresAt: number;
  createdBy: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionReason: string | null;
  commitId: string | null;
  expectedLastChangeId: number | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  entries: FakeChangeSetEntryRow[];
}

export interface FakeUploadSessionRow {
  id: string;
  stash: string;
  path: string;
  principal: { kind: "admin" } | { kind: "stash"; tokenId: string };
  state: UploadSessionState;
  expectedVersion: number | null;
  declaredSize: number;
  declaredHash: string | null;
  representation: Representation;
  contentType: string;
  mode: UploadMode;
  storageTier: StorageTier;
  partSize: number | null;
  expiresAt: number;
  attemptGeneration: number;
  uploadedBytes: Uint8Array | null;
  uploadedHash: string | null;
  parts: Map<number, Uint8Array>;
  result: UploadCompletionResult | null;
  createKey: string | null;
  completeKey: string | null;
  uploadKey: string | null;
  abortKey: string | null;
  terminalCurrent: Current | null;
  skipIfUnchanged: boolean;
}

export interface FakeGcJobRow {
  kind: GcKind;
  nextCursor: string | null;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseUntil: number | null;
  updatedAt: number;
}

export interface FakeIdempotencyRow {
  stash: string;
  key: string;
  requestHash: string;
  path: string;
  version: number;
  statusCode: 200 | 201;
  createdAt: number;
}

/** Inspectable in-memory tables. Maps are intentionally exposed for tests. */
export interface FakeStashState {
  stashes: Map<string, FakeStashRow>;
  tokens: Map<string, FakeTokenRow>;
  blobs: Map<string, Map<string, FakeBlobRow>>;
  r2Objects: Map<string, FakeR2ObjectRow>;
  files: Map<string, Map<string, FakeFileRow>>;
  versions: FakeVersionRow[];
  commits: Map<string, FakeCommitRow>;
  changeSets: Map<string, FakeChangeSetRow>;
  idempotency: Map<string, Map<string, FakeIdempotencyRow>>;
  gcJobs: Map<GcKind, FakeGcJobRow>;
  gcRuns: GcRunResult[];
  uploadSessions: Map<string, FakeUploadSessionRow>;
}

/** Controllable in-memory source backing the fake's authenticated SSE route. */
export interface FakeStashEvents {
  /** Broadcasts an advisory event using the stash carried by that event. */
  emit(event: Extract<StashEvent, { stash: string }>): void;
  /** Broadcasts any valid event to one stash, including ready/reconnect test fixtures. */
  emit(stash: string, event: StashEvent): void;
  /** Emits a reconnect frame and closes every current subscriber for the stash. */
  rotate(stash: string, reason?: ReconnectReason): void;
  /** Simulates a clean remote EOF without a reconnect frame. */
  close(stash: string): void;
  /** Simulates a body/network failure for current subscribers. */
  error(stash: string, error?: unknown): void;
  /** Returns the current number of open response bodies for one stash. */
  subscriberCount(stash: string): number;
}

export interface FakeStash {
  /** Fetch-compatible surface, including the authenticated fetch-only events route. */
  fetch: StashFetch;
  state: FakeStashState;
  /** Stable controller for live-event fixtures, rotations, clean closes, and network errors. */
  events: FakeStashEvents;
  /** Creates a stash directly for fixture setup and returns its public name. */
  createStash(name: string): string;
  /** Mints a fixture token through the same hash-only storage path as the HTTP route. */
  mintToken(stash: string, scope: TokenScope, options?: FakeMintTokenOptions): Promise<string>;
  /** Clears every in-memory table while preserving the state object identity. */
  reset(): void;
}

export interface ConformanceRateLimitTarget {
  capability: RateLimitCapability;
  key: string;
  routeId: RouteId;
  stash: string;
  token: string;
}

export interface ConformanceOptions {
  adminToken: string;
  /** Optional stable primary stash name for repeatable unit tests. Defaults to a unique name. */
  stashName?: string;
  /** Advances the target's clock far enough to cross a token-expiry boundary. */
  advanceTime(milliseconds: number): void | Promise<void>;
  /** Arranges for the named capability/key to be denied before the trace sends its assertion. */
  configureRateLimit(target: ConformanceRateLimitTarget): void | Promise<void>;
}

export interface ConformanceReport {
  stash: string;
  foreignStash: string;
  exercisedRouteIds: RouteId[];
  steps: number;
}
