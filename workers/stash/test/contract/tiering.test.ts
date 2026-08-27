import { describe, expect, it } from "vitest";
import {
  API_BASE_URL,
  MUTATION_ALLOWED,
  TEST_TIER,
  isLoopbackBaseUrl,
  mutationAllowedFor,
  parseTestTier,
} from "./env.js";

describe("contract tier safety", () => {
  it("accepts only the documented environment tiers", () => {
    expect(parseTestTier(undefined)).toBe("local");
    expect(parseTestTier("local")).toBe("local");
    expect(parseTestTier("preview")).toBe("preview");
    expect(parseTestTier("production")).toBe("production");
    expect(() => parseTestTier("staging")).toThrow(/TEST_TIER/u);
  });

  it("allows mutation only for the local tier on a loopback origin", () => {
    expect(isLoopbackBaseUrl("http://localhost:8787/api")).toBe(true);
    expect(isLoopbackBaseUrl("http://127.0.0.1:8787/api")).toBe(true);
    expect(isLoopbackBaseUrl("http://[::1]:8787/api")).toBe(true);
    expect(isLoopbackBaseUrl("https://stash.example.com")).toBe(false);
    expect(mutationAllowedFor("local", "http://localhost:8787/api")).toBe(true);
    expect(mutationAllowedFor("local", "https://stash.example.com")).toBe(false);
    expect(mutationAllowedFor("preview", "http://localhost:8787/api")).toBe(false);
    expect(mutationAllowedFor("production", "http://localhost:8787/api")).toBe(false);
    expect(MUTATION_ALLOWED).toBe(TEST_TIER === "local" && isLoopbackBaseUrl(API_BASE_URL));
  });
});
