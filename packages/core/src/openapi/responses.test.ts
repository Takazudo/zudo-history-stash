import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../errors.js";
import type { ErrorCode } from "../types.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";

describe("response schemas", () => {
  it("accepts one sample per registry entry", () => {
    for (const name of Object.keys(RESPONSE_SCHEMAS) as Array<keyof typeof RESPONSE_SCHEMAS>) {
      expect(RESPONSE_SCHEMAS[name].safeParse(SAMPLES[name]).success, name).toBe(true);
    }
  });
  it("pins commit grouping and conflict details", () => {
    expect(RESPONSE_SCHEMAS.StashChangeEvent.safeParse(SAMPLES.StashChangeEvent).success).toBe(true);
    expect(SAMPLES.StashChangeEvent.commitId).toBe(SAMPLES.CommitRecord.id);
    expect(RESPONSE_SCHEMAS.ErrorResponse.safeParse({ error: { code: "commit-conflict", message: "conflict" }, conflicts: [{ path: "a", expectedVersion: null, current: null }] }).success).toBe(true);
  });
  it("keeps error codes type-compatible", () => {
    const codes: readonly ErrorCode[] = ERROR_CODES;
    expect(codes).toContain("change-set-expired");
  });
});
