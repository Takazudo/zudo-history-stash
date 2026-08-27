import type {
  GcKind,
  GcRunResult,
  JsonValue,
  RouteId,
  TokenScope,
  VersionKind,
} from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../client.js";

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
  body: string;
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
  stash: string;
  path: string;
  version: number;
  kind: VersionKind;
  hash: string | null;
  size: number;
  contentType: string;
  rollbackOf: number | null;
  author: string;
  message: string;
  meta: Record<string, JsonValue>;
  createdAt: number;
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
  idempotency: Map<string, Map<string, FakeIdempotencyRow>>;
  gcJobs: Map<GcKind, FakeGcJobRow>;
  gcRuns: GcRunResult[];
}

export interface FakeStash {
  fetch: StashFetch;
  state: FakeStashState;
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
