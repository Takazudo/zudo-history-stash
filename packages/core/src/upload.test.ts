import { describe, expect, it } from "vitest";
import {
  assertUploadGeneration,
  assertUploadSessionTransition,
  assertUploadWriteAllowed,
  canTakeFinalizationLease,
  canTransitionUploadSession,
  isUploadTerminalState,
  UPLOAD_SESSION_STATES,
} from "./upload.js";

describe("upload session state machine", () => {
  it("pins every state and permits only explicit forward transitions", () => {
    expect(UPLOAD_SESSION_STATES).toEqual([
      "open",
      "uploaded",
      "finalizing",
      "committed",
      "aborted",
      "expired",
      "stale",
      "failed",
    ]);
    expect(canTransitionUploadSession("open", "uploaded")).toBe(true);
    expect(canTransitionUploadSession("uploaded", "finalizing")).toBe(true);
    expect(canTransitionUploadSession("finalizing", "committed")).toBe(true);
    expect(canTransitionUploadSession("committed", "uploaded")).toBe(false);
    expect(() => assertUploadSessionTransition("aborted", "open")).toThrow(/Illegal/);
    expect(UPLOAD_SESSION_STATES.filter(isUploadTerminalState)).toEqual([
      "committed",
      "aborted",
      "expired",
      "stale",
      "failed",
    ]);
  });

  it("fences stale upload work by generation", () => {
    expect(() => assertUploadGeneration(3, 3)).not.toThrow();
    expect(() => assertUploadGeneration(3, 2)).toThrow("Stale upload session generation");
    expect(() => assertUploadWriteAllowed("open", 3, 3)).not.toThrow();
    expect(() => assertUploadWriteAllowed("open", 3, 2)).toThrow("Stale");
    for (const state of [
      "uploaded",
      "finalizing",
      "committed",
      "aborted",
      "expired",
      "stale",
      "failed",
    ] as const) {
      expect(() => assertUploadWriteAllowed(state, 3, 3), state).toThrow("does not accept bytes");
    }
  });

  it("allows finalization takeover only after lease expiry", () => {
    const base = {
      state: "finalizing" as const,
      leaseOwner: "owner-a",
      leaseExpiresAt: 2_000,
      contender: "owner-b",
    };
    expect(canTakeFinalizationLease({ ...base, now: 1_999 })).toBe(false);
    expect(canTakeFinalizationLease({ ...base, now: 2_000 })).toBe(true);
    expect(canTakeFinalizationLease({ ...base, contender: "owner-a", now: 1_000 })).toBe(true);
    expect(canTakeFinalizationLease({ ...base, state: "committed", now: 3_000 })).toBe(false);
  });
});
