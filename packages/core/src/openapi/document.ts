import type { ZodType } from "zod";
import { statusForCode } from "../errors.js";
import { ROUTES } from "../routes.js";
import type { RoutePrincipal } from "../routes.js";
import { ROUTE_CONTRACTS } from "./contracts.js";
import type { RequestHeader, ResponseHeader, RouteContract } from "./contracts.js";
import { projectRequestSchema, projectResponseSchemas } from "./project.js";
import type { JsonSchema } from "./project.js";
import { SAMPLES } from "./samples.js";

type OpenApiValue = unknown;
type OpenApiObject = Record<string, OpenApiValue>;

export interface OpenApiDocument extends OpenApiObject {
  openapi: "3.1.0";
  info: { title: "zudo-history-stash"; version: string; description: string };
  servers: [{ url: "https://stash.example.com" }];
  security: [{ bearer: [] }];
  paths: Record<string, Record<string, OpenApiObject>>;
  components: {
    securitySchemes: { bearer: { type: "http"; scheme: "bearer" } };
    schemas: Record<string, JsonSchema>;
  };
}

const DOCUMENT_DESCRIPTION = [
  "Credentials for one stash cannot reveal another stash: foreign stashes are concealed as 404 responses.",
  "Lists and change feeds use keyset cursors (after, before, or since); limit defaults to 50 and has a maximum of 200.",
  "File reads use ETags, If-None-Match, and 304 responses for conditional requests.",
  "Mutation idempotency keys are retained in a 7-day ledger; reusing a key for a different request returns 422 idempotency-key-reused.",
].join("\n\n");

const WILDCARD_WARNING =
  "The path value contains unescaped `/`. OpenAPI 3.1 path templating does not permit this, so generated clients must not be assumed to work for this operation.";
const FILE_PATH_DESCRIPTION =
  "A non-empty slash-separated path whose segments contain only ASCII letters, digits, dots, underscores, or hyphens and are neither dot nor dot-dot; maximum 512 UTF-8 bytes.";
const STASH_NAME_DESCRIPTION =
  "A 1-63 character stash name containing lowercase ASCII letters, digits, or hyphens and beginning with a letter or digit.";

function pathTemplate(template: string): string {
  return template.replace(/:([^/]+)/g, "{$1}").replace("*path", "{path}");
}

function pathParameters(template: string, wildcard: boolean): OpenApiObject[] {
  const names = [...template.matchAll(/:([^/]+)/g)].map((match) => match[1] as string);
  if (wildcard) names.push("path");
  return names.map((name) => ({
    name,
    in: "path",
    required: true,
    ...(name === "path" ? { "x-wildcard": true } : {}),
    description:
      name === "path"
        ? `${FILE_PATH_DESCRIPTION} ${WILDCARD_WARNING}`
        : name === "stash"
          ? STASH_NAME_DESCRIPTION
          : "Resource identifier.",
    schema: { type: "string" },
  }));
}

function queryParameters(schema: ZodType | undefined): OpenApiObject[] {
  if (!schema) return [];
  const projected = projectRequestSchema(schema);
  const properties = projected.properties as Record<string, JsonSchema> | undefined;
  const required = new Set(Array.isArray(projected.required) ? projected.required : []);
  return Object.entries(properties ?? {}).map(([name, propertySchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    style: "form",
    explode: false,
    schema: propertySchema,
  }));
}

function requestHeaderParameter(name: RequestHeader): OpenApiObject {
  return {
    name,
    in: "header",
    required: false,
    schema:
      name === "Idempotency-Key"
        ? { type: "string", minLength: 1, maxLength: 200 }
        : { type: "string" },
  };
}

function responseHeader(name: ResponseHeader): OpenApiObject {
  return {
    description:
      name === "ETag"
        ? "Entity tag for this exact file version."
        : name === "X-Stash-Version"
          ? "Numeric stash file version."
          : "Whether the idempotency ledger replayed the response.",
    schema: {
      type:
        name === "Idempotent-Replayed"
          ? "boolean"
          : name === "X-Stash-Version"
            ? "integer"
            : "string",
    },
  };
}

function successResponses(contract: RouteContract): Record<string, OpenApiObject> {
  return Object.fromEntries(
    Object.entries(contract.responses).map(([status, response]) => {
      if (!response) throw new Error(`Missing response contract for ${status}`);
      const headers = response.headers
        ? {
            headers: Object.fromEntries(
              response.headers.map((name) => [name, responseHeader(name)]),
            ),
          }
        : {};
      const content = response.schema
        ? {
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${response.schema}` },
                ...(response.example ? { example: SAMPLES[response.example] } : {}),
              },
            },
          }
        : {};
      return [status, { description: response.description, ...headers, ...content }];
    }),
  );
}

function errorResponses(contract: RouteContract): Record<string, OpenApiObject> {
  const grouped = new Map<number, typeof contract.errors>();
  for (const error of contract.errors) {
    const status = statusForCode(error.code);
    grouped.set(status, [...(grouped.get(status) ?? []), error]);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([status, errors]) => [
        String(status),
        {
          description: `Errors: ${errors
            .map(({ code, current }) => `\`${code}\`${current ? " (includes current)" : ""}`)
            .join(", ")}.`,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
          },
        },
      ]),
  );
}

function buildOperation(
  route: { id: string; method: string; template: string; principal: RoutePrincipal },
  contract: RouteContract,
): OpenApiObject {
  const wildcard = contract.wildcardPath;
  const parameters = [
    ...pathParameters(route.template, wildcard),
    ...queryParameters(contract.query),
    ...(contract.requestHeaders ?? []).map(requestHeaderParameter),
  ];
  return {
    operationId: route.id,
    summary: contract.summary,
    description: [
      contract.description,
      contract.principalNote,
      ...(wildcard ? [WILDCARD_WARNING] : []),
    ].join("\n\n"),
    "x-principal": route.principal,
    ...(wildcard ? { "x-wildcard": true } : {}),
    ...(route.id === "health" ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(contract.body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: projectRequestSchema(contract.body) } },
          },
        }
      : {}),
    responses: { ...successResponses(contract), ...errorResponses(contract) },
  };
}

export function buildOpenApiDocument({ version }: { version: string }): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const route of ROUTES) {
    const path = pathTemplate(route.template);
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = buildOperation(route, ROUTE_CONTRACTS[route.id]);
  }

  return {
    openapi: "3.1.0",
    info: { title: "zudo-history-stash", version, description: DOCUMENT_DESCRIPTION },
    servers: [{ url: "https://stash.example.com" }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: projectResponseSchemas(),
    },
  };
}
