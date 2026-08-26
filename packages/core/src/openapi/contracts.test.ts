import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../errors.js";
import { ROUTES } from "../routes.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";
import { ROUTE_CONTRACTS } from "./contracts.js";

const routeIds = ROUTES.map(({ id }) => id);

describe("route contract coverage", () => {
  it("has exactly one contract for every route", () => {
    expect(new Set(Object.keys(ROUTE_CONTRACTS))).toEqual(new Set(routeIds));
    expect(new Set(Object.keys(ROUTE_CONTRACTS)).size).toBe(routeIds.length);
  });

  it("keeps wildcard path metadata aligned with the route templates", () => {
    for (const route of ROUTES) {
      const contract = ROUTE_CONTRACTS[route.id];
      expect(contract.wildcardPath, route.id).toBe(route.template.includes("*path"));
    }
  });

  it("references only registered response schemas and examples", () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      for (const [status, response] of Object.entries(contract.responses)) {
        if (response?.schema) {
          expect(RESPONSE_SCHEMAS[response.schema], `${routeId} ${status} schema`).toBeDefined();
        }
        if (response?.example) {
          expect(SAMPLES[response.example], `${routeId} ${status} example`).toBeDefined();
        }
      }
    }
  });

  it("references known, unique error codes for every route", () => {
    for (const [routeId, contract] of Object.entries(ROUTE_CONTRACTS)) {
      const codes = contract.errors.map(({ code }) => code);
      expect(new Set(codes).size, `${routeId} error uniqueness`).toBe(codes.length);
      for (const code of codes) {
        expect((ERROR_CODES as readonly string[]).includes(code), `${routeId} ${code}`).toBe(true);
      }
    }
  });

  it("marks only errors that include the root-level current head", () => {
    const expected = {
      health: [],
      me: [],
      listStashes: [],
      createStash: [],
      getStash: [],
      createToken: [],
      listTokens: [],
      revokeToken: [],
      importHistory: ["stale", "exists"],
      listChanges: [],
      listFiles: [],
      getFile: ["file-deleted"],
      putFile: ["stale", "exists"],
      deleteFile: ["stale", "already-deleted"],
      rollbackFile: ["version-not-found", "stale", "rollback-target-tombstone"],
      getHistory: [],
      getDiff: [],
      diffCandidate: [],
      getStashChanges: [],
    } as const;

    for (const route of ROUTES) {
      const currentCodes = ROUTE_CONTRACTS[route.id].errors
        .filter(({ current }) => current)
        .map(({ code }) => code)
        .sort();
      expect(currentCodes, route.id).toEqual([...expected[route.id]].sort());
    }
  });

  it("declares the idempotency request and replay headers on every file write", () => {
    for (const routeId of ["putFile", "deleteFile", "rollbackFile"] as const) {
      const contract = ROUTE_CONTRACTS[routeId];
      expect(contract.requestHeaders, routeId).toEqual(["Idempotency-Key"]);
      for (const response of Object.values(contract.responses)) {
        expect(response?.headers, routeId).toContain("Idempotent-Replayed");
      }
    }
  });

  it("documents conditional file reads with both representation headers", () => {
    const contract = ROUTE_CONTRACTS.getFile;
    expect(contract.requestHeaders).toEqual(["If-None-Match"]);
    expect(contract.responses[200]?.headers).toEqual(["ETag", "X-Stash-Version"]);
    expect(contract.responses[304]).toMatchObject({
      headers: ["ETag", "X-Stash-Version"],
    });
    expect(contract.responses[304]?.schema).toBeUndefined();
    expect(contract.responses[304]?.example).toBeUndefined();
  });
});
