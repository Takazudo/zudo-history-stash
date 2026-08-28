import type { ZodType } from "zod";
import { statusForCode } from "../errors.js";
import { ROUTES } from "../routes.js";
import type { RoutePrincipal } from "../routes.js";
import { STASH_CLIENT_ID_HEADER, STASH_CLIENT_ID_PATTERN } from "../schemas.js";
import { ROUTE_CONTRACTS } from "./contracts.js";
import type { RequestHeader, ResponseHeader, RouteContract } from "./contracts.js";
import { projectRequestSchema, projectResponseSchemas } from "./project.js";
import type { JsonSchema } from "./project.js";
import { SAMPLES } from "./samples.js";

declare const __CORE_VERSION__: string;

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
  "File-mutation idempotency keys are retained in a 7-day ledger. Proposal-creation keys are stored on the proposal row instead; either kind returns 422 idempotency-key-reused when reused for a different canonical request.",
  "Stash deletion is soft, names are never recycled, and restoration never reactivates revoked tokens.",
  "GC runs are synchronously bounded pages with stable jobId equal to kind, UUID runId values, opaque v1 kind-bound cursors, and a five-minute fenced lease; dry runs never delete or persist progress. A null cursor completes a pass and a later invocation starts a fresh pass; run history retains at most 500 entries per kind, and private R2 object keys never appear in responses or logs.",
  "Proposals are expiring candidate writes against an immutable base. Approval never rebases: a moved head returns 409 stale with current, while repeated creation and approval have explicit replay semantics.",
  "The per-stash live stream uses bearer-authenticated fetch and Server-Sent Events. It is fetch-only because browser EventSource cannot send the Authorization header and streaming responses are not exposed as named RPC methods.",
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
  if (name === STASH_CLIENT_ID_HEADER) {
    return {
      name,
      in: "header",
      required: false,
      description:
        "Stable mutation origin identifier. Use 1-64 printable ASCII characters without leading or trailing whitespace.",
      schema: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: STASH_CLIENT_ID_PATTERN.source,
      },
    };
  }
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
  const descriptions: Record<ResponseHeader, string> = {
    ETag: "Strong application SHA-256 entity tag for this exact file version.",
    "X-Stash-Version": "Numeric stash file version.",
    "Idempotent-Replayed": "Whether the server replayed an idempotent response.",
    "Retry-After": "Seconds to wait before retrying a rate-limited request.",
    "Cache-Control": "Response cache policy.",
    "X-Accel-Buffering": "Reverse-proxy response buffering policy.",
    "Accept-Ranges": "Supported range unit; always bytes for raw content.",
    "Content-Length": "Exact response content bytes.",
    "Content-Range": "Selected byte range or the complete size for an unsatisfied range.",
    "Content-Type": "Stored media type.",
    "Content-Disposition": "Safely encoded inline or attachment disposition.",
    "X-Content-Type-Options": "Prevents MIME sniffing of stored content.",
  };
  return {
    description: descriptions[name],
    schema: {
      type:
        name === "Idempotent-Replayed"
          ? "boolean"
          : name === "X-Stash-Version" || name === "Retry-After" || name === "Content-Length"
            ? "integer"
            : "string",
      ...(name === "Retry-After" ? { minimum: 0 } : {}),
      ...(name === "Cache-Control"
        ? { const: "no-store" }
        : name === "X-Accel-Buffering"
          ? { const: "no" }
          : name === "Accept-Ranges"
            ? { const: "bytes" }
            : name === "X-Content-Type-Options"
              ? { const: "nosniff" }
              : {}),
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
              [response.mediaType ?? "application/json"]: {
                schema: { $ref: `#/components/schemas/${response.schema}` },
                ...(response.example ? { example: SAMPLES[response.example] } : {}),
              },
            },
          }
        : response.mediaType === "application/octet-stream"
          ? {
              content: {
                "application/octet-stream": { schema: { type: "string", format: "binary" } },
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
          ...(() => {
            const headers = [...new Set(errors.flatMap((error) => error.headers ?? []))];
            return headers.length
              ? {
                  headers: Object.fromEntries(headers.map((name) => [name, responseHeader(name)])),
                }
              : {};
          })(),
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
    ...(contract.transport === "fetch-only" ? { "x-transport": "fetch-only" } : {}),
    ...(wildcard ? { "x-wildcard": true } : {}),
    ...(route.principal === "open" ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(contract.body || contract.rawBody
      ? {
          requestBody: {
            required: true,
            content: {
              [contract.requestMediaType ?? "application/json"]: {
                schema: contract.rawBody
                  ? { type: "string", format: "binary" }
                  : projectRequestSchema(contract.body as ZodType),
              },
            },
          },
        }
      : {}),
    responses: { ...successResponses(contract), ...errorResponses(contract) },
  };
}

export function buildOpenApiDocument({
  version = typeof __CORE_VERSION__ === "string" ? __CORE_VERSION__ : "0.0.0",
} = {}): OpenApiDocument {
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
