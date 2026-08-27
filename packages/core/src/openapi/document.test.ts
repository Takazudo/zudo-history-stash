import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes.js";
import { RESPONSE_SCHEMAS } from "./responses.js";
import { SAMPLES } from "./samples.js";
import { ROUTE_CONTRACTS } from "./contracts.js";
import { buildOpenApiDocument } from "./document.js";

type ObjectValue = Record<string, unknown>;

function operations(document: ReturnType<typeof buildOpenApiDocument>): ObjectValue[] {
  return Object.values(document.paths).flatMap((path) => Object.values(path));
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) throw new Error(`Unsupported reference: ${pointer}`);
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => (current as Record<string, unknown>)[part], root);
}

describe("buildOpenApiDocument", () => {
  it("builds the fixed OpenAPI 3.1 envelope and is deterministic", () => {
    const first = buildOpenApiDocument({ version: "1.2.3" });
    expect(first).toEqual(buildOpenApiDocument({ version: "1.2.3" }));
    expect(first).toMatchObject({
      openapi: "3.1.0",
      info: { title: "zudo-history-stash", version: "1.2.3" },
      servers: [{ url: "https://stash.example.com" }],
      security: [{ bearer: [] }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    });
  });

  it("contains every operation with the route identity and short principal", () => {
    const document = buildOpenApiDocument({ version: "test" });
    const all = operations(document);
    expect(all).toHaveLength(30);
    expect(all.map((operation) => operation.operationId)).toEqual(ROUTES.map((route) => route.id));
    for (const route of ROUTES) {
      const operation = all.find((candidate) => candidate.operationId === route.id);
      expect(operation?.["x-principal"], route.id).toBe(route.principal);
      expect(operation?.description, route.id).toContain(ROUTE_CONTRACTS[route.id].principalNote);
    }
    expect(all.find((operation) => operation.operationId === "health")?.security).toEqual([]);
  });

  it("marks all seven wildcard operations and warns about client generation", () => {
    const wildcardOperations = operations(buildOpenApiDocument({ version: "test" })).filter(
      (operation) => operation["x-wildcard"] === true,
    );
    expect(wildcardOperations).toHaveLength(7);
    for (const operation of wildcardOperations) {
      expect(operation.description).toContain("unescaped `/`");
      const parameters = operation.parameters as ObjectValue[];
      expect(parameters).toContainEqual(
        expect.objectContaining({ name: "path", in: "path", required: true, "x-wildcard": true }),
      );
      expect(parameters.find(({ name }) => name === "path")?.description).toContain(
        "generated clients must not be assumed to work",
      );
    }
  });

  it("declares both representation headers on getFile 200 and 304", () => {
    const responses = buildOpenApiDocument({ version: "test" }).paths[
      "/v1/stashes/{stash}/files/{path}"
    ]?.get?.responses as Record<string, ObjectValue>;
    for (const status of ["200", "304"]) {
      expect(responses[status]?.headers).toHaveProperty("ETag");
      expect(responses[status]?.headers).toHaveProperty("X-Stash-Version");
    }
  });

  it("emits resolvable references and no local-definition references", () => {
    const document = buildOpenApiDocument({ version: "test" });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("#/$defs");
    expect(serialized).not.toContain("#/definitions");
    const refs: string[] = [];
    JSON.stringify(document, (key, value: unknown) => {
      if (key === "$ref") refs.push(value as string);
      return value;
    });
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolvePointer(document, ref), ref).toBeDefined();
  });

  it("puts response examples on their response entries and keeps them schema-valid", () => {
    const document = buildOpenApiDocument({ version: "test" });
    const all = operations(document);
    for (const name of Object.keys(RESPONSE_SCHEMAS) as Array<keyof typeof RESPONSE_SCHEMAS>) {
      expect(() => RESPONSE_SCHEMAS[name].parse(SAMPLES[name]), name).not.toThrow();
    }
    for (const route of ROUTES) {
      const operation = all.find((candidate) => candidate.operationId === route.id);
      const responses = operation?.responses as Record<string, ObjectValue>;
      for (const [status, response] of Object.entries(ROUTE_CONTRACTS[route.id].responses)) {
        if (!response?.schema || !response.example) continue;
        const schema = RESPONSE_SCHEMAS[response.schema];
        const example = SAMPLES[response.example];
        expect(() => schema.parse(example)).not.toThrow();
        expect(
          ((responses[status]?.content as ObjectValue)["application/json"] as ObjectValue).example,
        ).toEqual(SAMPLES[response.example]);
      }
    }
  });

  it("groups route errors into one response per status and marks current-bearing codes", () => {
    const operation = operations(buildOpenApiDocument({ version: "test" })).find(
      (candidate) => candidate.operationId === "putFile",
    );
    const responses = operation?.responses as Record<string, ObjectValue>;
    expect(responses["409"]?.description).toContain("`stale` (includes current)");
    expect(responses["409"]?.description).toContain("`exists` (includes current)");
    expect(
      ((responses["409"]?.content as ObjectValue)["application/json"] as ObjectValue).schema,
    ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
  });

  it("documents Retry-After on every rate-limited response", () => {
    const document = buildOpenApiDocument({ version: "test" });
    const rateLimited = operations(document).filter((operation) => {
      const responses = operation.responses as Record<string, ObjectValue>;
      return responses["429"] !== undefined;
    });
    expect(rateLimited).toHaveLength(17);
    for (const operation of rateLimited) {
      const responses = operation.responses as Record<string, ObjectValue>;
      expect(responses["429"]?.headers).toHaveProperty("Retry-After");
    }
    const rotate = operations(document).find(
      (operation) => operation.operationId === "rotateToken",
    );
    const rotateResponses = rotate?.responses as Record<string, ObjectValue>;
    expect(rotateResponses["201"]).toBeDefined();
    expect(rotateResponses["429"]).toBeUndefined();
  });

  it("documents proposal replay, filters, decisions, and stale current metadata", () => {
    const document = buildOpenApiDocument({ version: "test" });
    const create = document.paths["/v1/stashes/{stash}/proposals"]?.post;
    const createResponses = create?.responses as Record<string, ObjectValue>;
    expect(create?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Idempotency-Key", in: "header", required: false }),
      ]),
    );
    expect(createResponses["201"]?.headers).toHaveProperty("Idempotent-Replayed");
    expect(
      (createResponses["201"]?.headers as Record<string, ObjectValue>)["Idempotent-Replayed"]
        ?.description,
    ).toBe("Whether the server replayed an idempotent response.");

    const approve = document.paths["/v1/stashes/{stash}/proposals/{id}/approve"]?.post;
    const approveResponses = approve?.responses as Record<string, ObjectValue>;
    expect(approveResponses["409"]?.description).toContain("`stale` (includes current)");
    expect(approveResponses["409"]?.description).toContain("`proposal-expired`");
    expect(approveResponses["409"]?.description).toContain("`proposal-closed`");
    expect(approveResponses["413"]?.description).toContain("`payload-too-large`");

    const reject = document.paths["/v1/stashes/{stash}/proposals/{id}/reject"]?.post;
    const rejectResponses = reject?.responses as Record<string, ObjectValue>;
    expect(rejectResponses["413"]?.description).toContain("`payload-too-large`");
    const rejectExample = (
      (rejectResponses["200"]?.content as ObjectValue)["application/json"] as ObjectValue
    ).example;
    expect(rejectExample).toEqual(SAMPLES.RejectedProposalRecord);
    expect(rejectExample).toMatchObject({
      status: "rejected",
      decidedAt: "2026-08-26T01:00:00.000Z",
      decidedBy: "admin",
      decisionReason: "Superseded by a newer proposal",
    });
  });
});
