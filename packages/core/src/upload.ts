import type { Representation, StorageTier, UploadMode } from "./binary.js";

export const UPLOAD_SESSION_STATES = [
  "open",
  "uploaded",
  "finalizing",
  "committed",
  "aborted",
  "expired",
  "stale",
  "failed",
] as const;

export type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];
export type UploadTerminalState = Extract<
  UploadSessionState,
  "committed" | "aborted" | "expired" | "stale" | "failed"
>;

export interface UploadSessionIdentity {
  id: string;
  stash: string;
  path: string;
  principal: { kind: "admin" } | { kind: "stash"; tokenId: string };
}

export interface UploadSessionRecord extends UploadSessionIdentity {
  state: UploadSessionState;
  expectedVersion: number | null;
  declaredSize: number;
  declaredHash: string | null;
  representation: Representation;
  contentType: string;
  mode: UploadMode;
  storageTier: StorageTier;
  partSize: number | null;
  expiresAt: string;
  attemptGeneration: number;
  uploadedSize: number | null;
  uploadedHash: string | null;
  finalizationLeaseOwner: string | null;
  finalizationLeaseExpiresAt: string | null;
  /** Replayable successful or terminal completion payload, never an R2 credential/key. */
  result: UploadCommitResult | null;
}

export interface UploadCommitResult {
  version: number;
  hash: string;
  size: number;
  representation: Representation;
  contentType: string;
  changeId: number;
  createdAt: string;
}

export interface UploadPartRecord {
  partNumber: number;
  size: number;
  generation: number;
  /** Server-recorded R2 multipart ETag; clients never supply the completion manifest. */
  etag: string;
}

export interface UploadSessionStore {
  get(sessionId: string): Promise<UploadSessionRecord | null>;
  listParts(sessionId: string, generation: number): Promise<UploadPartRecord[]>;
}

const ALLOWED_TRANSITIONS: Readonly<Record<UploadSessionState, readonly UploadSessionState[]>> = {
  open: ["uploaded", "aborted", "expired", "failed"],
  uploaded: ["finalizing", "aborted", "expired", "failed"],
  finalizing: ["committed", "aborted", "stale", "failed"],
  committed: [],
  aborted: [],
  expired: [],
  stale: [],
  failed: [],
};

export function isUploadTerminalState(state: UploadSessionState): state is UploadTerminalState {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export function canTransitionUploadSession(
  from: UploadSessionState,
  to: UploadSessionState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertUploadSessionTransition(
  from: UploadSessionState,
  to: UploadSessionState,
): void {
  if (!canTransitionUploadSession(from, to)) {
    throw new Error(`Illegal upload session transition: ${from} -> ${to}`);
  }
}

export function assertUploadGeneration(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("Stale upload session generation");
}

/** Guards single/part writes; uploaded, finalizing, and every terminal state reject late bytes. */
export function assertUploadWriteAllowed(
  state: UploadSessionState,
  actualGeneration: number,
  expectedGeneration: number,
): void {
  assertUploadGeneration(actualGeneration, expectedGeneration);
  if (state !== "open") throw new Error(`Upload session does not accept bytes in state ${state}`);
}

export function canTakeFinalizationLease(input: {
  state: UploadSessionState;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  contender: string;
  now: number;
}): boolean {
  if (input.state === "uploaded") return true;
  if (input.state !== "finalizing") return false;
  if (input.leaseOwner === input.contender) return true;
  return input.leaseExpiresAt !== null && input.now >= input.leaseExpiresAt;
}
