import { readFileSync } from "node:fs";

import prettier from "prettier";
import { describe, expect, it } from "vitest";
import { statusForCode } from "../errors.js";
import { ROUTES } from "../routes.js";
import { ROUTE_CONTRACTS } from "./contracts.js";
import type { OpenApiDocument } from "./document.js";
import { buildOpenApiDocument } from "./document.js";

const apiReferenceUrl = new URL("../../../../docs/api.md", import.meta.url);
const openApiUrl = new URL("../../../../docs/openapi.json", import.meta.url);
const apiReference = readFileSync(apiReferenceUrl, "utf8");
const committedOpenApi = JSON.parse(readFileSync(openApiUrl, "utf8")) as OpenApiDocument;

type ApiSection = {
  method: string;
  template: string;
  body: string;
};

type Route = (typeof ROUTES)[number];

type DocumentedRouteSection = {
  route: Route;
  section: ApiSection;
};

type OpenApiOperation = Record<string, unknown> & {
  operationId?: unknown;
  "x-principal"?: unknown;
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

async function formatOpenApi(document: OpenApiDocument): Promise<string> {
  const config = (await prettier.resolveConfig(openApiUrl)) ?? {};
  return prettier.format(JSON.stringify(sortKeys(document), null, 2), {
    ...config,
    parser: "json",
  });
}

function apiSections(): ApiSection[] {
  const headings = [...apiReference.matchAll(/^### `(GET|POST|PUT|DELETE) (\/v1\/[^`]+)`$/gm)];
  return headings.map((heading, index) => {
    const method = heading[1];
    const template = heading[2];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? apiReference.length;
    if (!method || !template) throw new Error("Invalid API route heading");
    return { method, template, body: apiReference.slice(start, end) };
  });
}

function documentedRouteSections(): DocumentedRouteSection[] {
  return apiSections().map((section) => {
    const route = ROUTES.find(
      ({ method, template }) => method === section.method && template === section.template,
    );
    if (!route) throw new Error(`Unknown API route heading: ${section.method} ${section.template}`);
    return { route, section };
  });
}

function bullet(section: ApiSection, name: "Response" | "Errors"): string {
  const lines = section.body.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`- **${name}:**`));
  if (start < 0)
    throw new Error(`Missing ${name} bullet for ${section.method} ${section.template}`);
  const firstLine = lines[start];
  if (!firstLine)
    throw new Error(`Missing ${name} bullet for ${section.method} ${section.template}`);
  const content = [firstLine.slice(`- **${name}:**`.length)];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- **") || line.startsWith("#")) break;
    content.push(line);
  }
  return content.join(" ").replace(/\s+/g, " ").trim();
}

function operations(document: OpenApiDocument): OpenApiOperation[] {
  return Object.values(document.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation as OpenApiOperation),
  );
}

describe("OpenAPI and API reference drift", () => {
  it("keeps the committed OpenAPI document equal to the generated document", async () => {
    const generated = buildOpenApiDocument();

    expect(committedOpenApi, "docs/openapi.json is out of date; run pnpm openapi:generate").toEqual(
      generated,
    );
    expect(
      readFileSync(openApiUrl, "utf8"),
      "docs/openapi.json is out of date; run pnpm openapi:generate",
    ).toBe(await formatOpenApi(generated));
  });

  it("keeps documented error status/code pairs equal to each route contract", () => {
    const routeSections = documentedRouteSections();
    expect(routeSections, "API reference route section count").toHaveLength(ROUTES.length);
    expect(new Set(routeSections.map(({ route }) => route.id))).toEqual(
      new Set(ROUTES.map(({ id }) => id)),
    );
    for (const { route, section } of routeSections) {
      const errors = bullet(section, "Errors");
      const actual = new Set(
        [...errors.matchAll(/\b(\d{3})\s+`?([a-z][a-z0-9-]*)`?\b/g)].map(
          ([, status, code]) => `${status} ${code}`,
        ),
      );
      const expected = new Set(
        ROUTE_CONTRACTS[route.id].errors.map(({ code }) => `${statusForCode(code)} ${code}`),
      );
      expect(actual, `${route.method} ${route.template} error pairs`).toEqual(expected);
    }
  });

  it("keeps documented success statuses and response headers equal to each route contract", () => {
    const routeSections = documentedRouteSections();
    expect(routeSections, "API reference route section count").toHaveLength(ROUTES.length);
    expect(new Set(routeSections.map(({ route }) => route.id))).toEqual(
      new Set(ROUTES.map(({ id }) => id)),
    );
    for (const { route, section } of routeSections) {
      const response = bullet(section, "Response");
      for (const [status, contractResponse] of Object.entries(
        ROUTE_CONTRACTS[route.id].responses,
      )) {
        expect(response, `${route.method} ${route.template} response ${status}`).toMatch(
          new RegExp(`\\b${status}\\b`),
        );
        for (const header of contractResponse?.headers ?? []) {
          expect(response, `${route.method} ${route.template} response ${status} header`).toContain(
            header,
          );
        }
      }
    }
  });

  it("keeps OpenAPI operationIds in exact two-way alignment with RouteIds", () => {
    const routeIds = ROUTES.map(({ id }) => id);
    const documentOperations = operations(committedOpenApi);
    const operationIds = documentOperations.map(({ operationId }) => operationId);

    expect(documentOperations).toHaveLength(routeIds.length);
    expect(new Set(operationIds)).toEqual(new Set(routeIds));
    for (const routeId of routeIds) {
      expect(operationIds, `missing operationId for ${routeId}`).toContain(routeId);
    }
    for (const operationId of operationIds) {
      expect(routeIds, `unexpected operationId ${String(operationId)}`).toContain(operationId);
    }
  });

  it("keeps OpenAPI x-principal values aligned with ROUTES", () => {
    const documentOperations = operations(committedOpenApi);
    for (const route of ROUTES) {
      const matches = documentOperations.filter(({ operationId }) => operationId === route.id);
      expect(matches, `operation for ${route.id}`).toHaveLength(1);
      expect(matches[0]?.["x-principal"], route.id).toBe(route.principal);
    }
    for (const operation of documentOperations) {
      const route = ROUTES.find(({ id }) => id === operation.operationId);
      expect(route, `unexpected operationId ${String(operation.operationId)}`).toBeDefined();
      expect(operation["x-principal"], String(operation.operationId)).toBe(route?.principal);
    }
  });
});
