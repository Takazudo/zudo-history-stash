import { describe, expect, it } from "vitest";
import { ROUTES, routeAcceptsClientId } from "../routes.js";
import { STASH_CLIENT_ID_HEADER } from "../schemas.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";
import { ROUTE_CONTRACTS } from "./contracts.js";

describe("route contract coverage", () => {
  it("has exactly one contract per route", () => {
    expect(new Set(Object.keys(ROUTE_CONTRACTS))).toEqual(new Set(ROUTES.map(({ id }) => id)));
  });
  it("references registered schemas and valid samples", () => {
    for (const route of ROUTES) {
      const contract = ROUTE_CONTRACTS[route.id];
      expect(contract.wildcardPath).toBe(route.template.includes("*path"));
      for (const response of Object.values(contract.responses)) {
        if (!response?.schema || !response.example) continue;
        expect(RESPONSE_SCHEMAS[response.schema].safeParse(SAMPLES[response.example]).success).toBe(true);
      }
    }
  });
  it("pins commit and change-set write semantics", () => {
    for (const id of ["createCommit", "revertCommit", "createChangeSet"] as const) {
      expect(ROUTE_CONTRACTS[id].requestHeaders).toContain("Idempotency-Key");
      expect(ROUTE_CONTRACTS[id].requestHeaders).toContain(STASH_CLIENT_ID_HEADER);
    }
    expect(ROUTE_CONTRACTS.createCommit.errors.map(({ code }) => code)).toContain("commit-conflict");
    expect(ROUTE_CONTRACTS.approveChangeSet.errors.map(({ code }) => code)).toEqual(expect.arrayContaining(["commit-conflict", "change-set-expired", "change-set-closed"]));
    expect(SAMPLES.RejectedChangeSetRecord.status).toBe("rejected");
  });
  it("keeps identity headers aligned", () => {
    for (const route of ROUTES) {
      const contract = ROUTE_CONTRACTS[route.id];
      const headers: readonly string[] = "requestHeaders" in contract ? contract.requestHeaders : [];
      expect(headers.includes(STASH_CLIENT_ID_HEADER), route.id).toBe(routeAcceptsClientId(route));
    }
  });
});
