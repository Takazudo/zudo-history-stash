import { describe, expect, expectTypeOf, it } from "vitest";
import { ERROR_CODES } from "../errors.js";
import { ROUTES, routeAcceptsClientId, transportForRoute } from "../routes.js";
import { STASH_CLIENT_ID_HEADER } from "../schemas.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";
import { ROUTE_CONTRACTS } from "./contracts.js";

const routeIds = ROUTES.map(({ id }) => id);
const clientIdentityRouteIds = [
  "createStash",
  "deleteStash",
  "restoreStash",
  "createToken",
  "rotateToken",
  "revokeToken",
  "importHistory",
  "runGc",
  "createProposal",
  "approveProposal",
  "rejectProposal",
  "putFile",
  "deleteFile",
  "rollbackFile",
  "createUploadSession",
  "abortUploadSession",
  "uploadSingleContent",
  "uploadPart",
  "completeUploadSession",
  "resumeUploadSession",
] as const;

describe("route contract coverage", () => {
  it("has exactly one contract for every route", () => {
    expect(new Set(Object.keys(ROUTE_CONTRACTS))).toEqual(new Set(routeIds));
    expect(new Set(Object.keys(ROUTE_CONTRACTS)).size).toBe(routeIds.length);
  });

  it("preserves literal per-route types on the public contract registry", () => {
    expectTypeOf(ROUTE_CONTRACTS.stashEvents.transport).toEqualTypeOf<"fetch-only">();
    expectTypeOf<keyof typeof ROUTE_CONTRACTS.createProposal.responses>().toEqualTypeOf<201>();
    expectTypeOf(ROUTE_CONTRACTS.createProposal.responses[201].schema).toEqualTypeOf<
      keyof typeof RESPONSE_SCHEMAS | undefined
    >();
    expectTypeOf(ROUTE_CONTRACTS.createProposal.requestHeaders).toEqualTypeOf<
      ["Idempotency-Key", "X-Stash-Client-Id"]
    >();
  });

  it("keeps wildcard path metadata aligned with the route templates", () => {
    for (const route of ROUTES) {
      const contract = ROUTE_CONTRACTS[route.id];
      expect(contract.wildcardPath, route.id).toBe(route.template.includes("*path"));
    }
  });

  it("declares client identity on exactly the mutations stamped by the SDK", () => {
    expect(ROUTES.filter(routeAcceptsClientId).map(({ id }) => id)).toEqual(clientIdentityRouteIds);
    for (const route of ROUTES) {
      const contract = ROUTE_CONTRACTS[route.id];
      const headers: readonly string[] =
        "requestHeaders" in contract ? contract.requestHeaders : [];
      const expected = clientIdentityRouteIds.includes(
        route.id as (typeof clientIdentityRouteIds)[number],
      );
      expect(headers.includes(STASH_CLIENT_ID_HEADER), route.id).toBe(expected);
      expect(
        headers.filter((header) => header === STASH_CLIENT_ID_HEADER),
        route.id,
      ).toHaveLength(expected ? 1 : 0);
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
      getCapabilities: [],
      me: [],
      listStashes: [],
      createStash: [],
      getStash: [],
      deleteStash: [],
      restoreStash: [],
      createToken: [],
      listTokens: [],
      rotateToken: [],
      revokeToken: [],
      importHistory: ["stale", "exists"],
      listChanges: [],
      runGc: [],
      listGcRuns: [],
      createProposal: [],
      listProposals: [],
      getProposal: [],
      getProposalDiff: [],
      approveProposal: ["stale"],
      rejectProposal: [],
      stashEvents: [],
      listFiles: [],
      getFile: ["file-deleted"],
      putFile: ["stale", "exists"],
      deleteFile: ["stale", "already-deleted"],
      rollbackFile: ["version-not-found", "stale", "rollback-target-tombstone"],
      getHistory: [],
      getDiff: [],
      diffCandidate: [],
      getStashChanges: [],
      getRawFile: [],
      headRawFile: [],
      getRawVersion: [],
      headRawVersion: [],
      createUploadSession: ["stale"],
      getUploadSession: [],
      uploadSingleContent: [],
      uploadPart: [],
      completeUploadSession: ["stale"],
      resumeUploadSession: [],
      abortUploadSession: [],
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
      expect(contract.requestHeaders, routeId).toEqual(["Idempotency-Key", STASH_CLIENT_ID_HEADER]);
      for (const response of Object.values(contract.responses)) {
        expect(response?.headers, routeId).toContain("Idempotent-Replayed");
      }
    }
  });

  it("pins raw upload request media independently from JSON schemas", () => {
    for (const routeId of ["uploadSingleContent", "uploadPart"] as const) {
      expect(ROUTE_CONTRACTS[routeId]).toMatchObject({
        rawBody: true,
        requestMediaType: "application/octet-stream",
      });
      expect("body" in ROUTE_CONTRACTS[routeId]).toBe(false);
    }
  });

  it("declares proposal-create replay metadata and stale approval current metadata", () => {
    expect(ROUTE_CONTRACTS.createProposal.requestHeaders).toEqual([
      "Idempotency-Key",
      STASH_CLIENT_ID_HEADER,
    ]);
    expect(ROUTE_CONTRACTS.createProposal.responses[201]?.headers).toEqual(["Idempotent-Replayed"]);
    expect(
      ROUTE_CONTRACTS.approveProposal.errors.find(({ code }) => code === "stale"),
    ).toMatchObject({ current: true });
  });

  it("pins decision payload limits and the rejected route sample", () => {
    for (const routeId of ["approveProposal", "rejectProposal"] as const) {
      expect(
        ROUTE_CONTRACTS[routeId].errors.map(({ code }) => code),
        routeId,
      ).toContain("payload-too-large");
    }
    expect(ROUTE_CONTRACTS.rejectProposal.responses[200]).toMatchObject({
      schema: "ProposalRecord",
      example: "RejectedProposalRecord",
    });
    expect(ROUTE_CONTRACTS.createProposal.responses[201]?.example).toBe("ProposalRecord");
    expect(SAMPLES.ProposalRecord.status).toBe("open");
    expect(SAMPLES.RejectedProposalRecord).toMatchObject({
      status: "rejected",
      decidedAt: "2026-08-26T01:00:00.000Z",
      decidedBy: "admin",
      decisionReason: "Superseded by a newer proposal",
    });
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

  it("marks streaming and binary-contract routes fetch-only and declares SSE", () => {
    const fetchOnly = ROUTES.filter(({ id }) => transportForRoute(id) === "fetch-only").map(
      ({ id }) => id,
    );
    expect(fetchOnly).toEqual([
      "getCapabilities",
      "stashEvents",
      "getRawFile",
      "headRawFile",
      "getRawVersion",
      "headRawVersion",
      "createUploadSession",
      "getUploadSession",
      "abortUploadSession",
      "uploadSingleContent",
      "uploadPart",
      "completeUploadSession",
      "resumeUploadSession",
    ]);
    for (const route of ROUTES) {
      expect(transportForRoute(route.id), route.id).toBe(
        fetchOnly.includes(route.id) ? "fetch-only" : "any",
      );
      const contract = ROUTE_CONTRACTS[route.id];
      expect("transport" in contract ? contract.transport : "any", route.id).toBe(
        transportForRoute(route.id),
      );
    }
    expect(ROUTE_CONTRACTS.stashEvents).toMatchObject({
      transport: "fetch-only",
      wildcardPath: false,
      responses: {
        200: {
          schema: "StashEvent",
          mediaType: "text/event-stream",
          headers: ["Cache-Control", "X-Accel-Buffering"],
        },
      },
    });
    expect(ROUTE_CONTRACTS.stashEvents.errors.map(({ code }) => code)).toEqual([
      "unauthorized",
      "scope",
      "not-found",
      "rate-limited",
    ]);
  });

  it("declares rate limiting only for stash-principal routes with Retry-After", () => {
    const expected = new Set([
      "me",
      "getStash",
      "createProposal",
      "listProposals",
      "getProposal",
      "getProposalDiff",
      "approveProposal",
      "rejectProposal",
      "stashEvents",
      "listFiles",
      "getFile",
      "putFile",
      "deleteFile",
      "rollbackFile",
      "getHistory",
      "getDiff",
      "diffCandidate",
      "getStashChanges",
      "getRawFile",
      "headRawFile",
      "getRawVersion",
      "headRawVersion",
      "createUploadSession",
      "getUploadSession",
      "uploadSingleContent",
      "uploadPart",
      "completeUploadSession",
      "resumeUploadSession",
      "abortUploadSession",
    ]);
    for (const route of ROUTES) {
      const rateLimit = ROUTE_CONTRACTS[route.id].errors.find(
        ({ code }) => code === "rate-limited",
      );
      if (expected.has(route.id)) {
        expect(rateLimit?.headers, route.id).toEqual(["Retry-After"]);
      } else {
        expect(rateLimit, route.id).toBeUndefined();
      }
    }
  });
});
