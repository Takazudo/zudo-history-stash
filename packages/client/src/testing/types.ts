import type {
  JsonValue,
  RouteId,
  TokenScope,
  VersionKind,
} from "@takazudo/zudo-history-stash-core";
import type { StashFetch } from "../client.js";

/** Options for the deliberately narrow in-memory History Stash fake. */
export interface FakeStashOptions {
  adminToken?: string;
  now?: () => number;
}

export interface FakeStashRow {
  name: string;
  description: string;
  meta: Record<string, JsonValue>;
  createdAt: number;
}

export interface FakeTokenRow {
  id: string;
  /** Bare SHA-256 digest; the plaintext secret is never retained in inspectable state. */
  tokenHash: string;
  stash: string;
  label: string;
  scope: TokenScope;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface FakeBlobRow {
  stash: string;
  hash: string;
  body: string;
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
  files: Map<string, Map<string, FakeFileRow>>;
  versions: FakeVersionRow[];
  idempotency: Map<string, Map<string, FakeIdempotencyRow>>;
}

export interface FakeStash {
  fetch: StashFetch;
  state: FakeStashState;
  /** Creates a stash directly for fixture setup and returns its public name. */
  createStash(name: string): string;
  /** Mints a fixture token through the same hash-only storage path as the HTTP route. */
  mintToken(stash: string, scope: TokenScope): Promise<string>;
  /** Clears every in-memory table while preserving the state object identity. */
  reset(): void;
}

export interface ConformanceOptions {
  adminToken: string;
  /** Optional stable primary stash name for repeatable unit tests. Defaults to a unique name. */
  stashName?: string;
}

export interface ConformanceReport {
  stash: string;
  foreignStash: string;
  exercisedRouteIds: RouteId[];
  steps: number;
}
