import { describe, expect, it } from "vitest";
import { MUTATION_ALLOWED, TEST_TIER, mutationAllowedFor, parseTestTier } from "./env.js";

describe("contract tier safety", () => {
  it("accepts only the documented environment tiers", () => {
    expect(parseTestTier(undefined)).toBe("local");
    expect(parseTestTier("local")).toBe("local");
    expect(parseTestTier("preview")).toBe("preview");
    expect(parseTestTier("production")).toBe("production");
    expect(() => parseTestTier("staging")).toThrow(/TEST_TIER/u);
  });

  it("allows mutation only in the local tier", () => {
    expect(mutationAllowedFor("local")).toBe(true);
    expect(mutationAllowedFor("preview")).toBe(false);
    expect(mutationAllowedFor("production")).toBe(false);
    expect(MUTATION_ALLOWED).toBe(TEST_TIER === "local");
  });
});
