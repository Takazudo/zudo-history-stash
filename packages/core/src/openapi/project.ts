import { z } from "zod";
import type { core, ZodType } from "zod";
import { MAX_BODY_BYTES } from "../limits.js";
import {
  ChangesQuery,
  ApproveChangeSetBody,
  ChangeSetDiffQuery,
  CommitDiffQuery,
  CreateChangeSetBody,
  CreateCommitBody,
  CreateStashBody,
  CreateTokenBody,
  DeleteFileBody,
  DiffCandidateBody,
  ImportBody,
  ListGcRunsQuery,
  ListChangeSetsQuery,
  ListStashesQuery,
  PutFileBody,
  RejectChangeSetBody,
  RevertCommitBody,
  RollbackBody,
  RunGcBody,
  RotateTokenBody,
} from "../schemas.js";
import { RESPONSE_SCHEMAS } from "./responses.js";

export type JsonSchema = Record<string, unknown>;

const OMIT_OPTIONAL_NEVER = "x-zudo-omit-optional-never";
const JSON_VALUE_DESCRIPTION =
  "Any JSON value. The recursive z.json() validator is intentionally represented as an unconstrained schema.";

interface ZodDefShape {
  type: string;
  getter?: () => core.$ZodType;
  innerType?: core.$ZodType;
  options?: core.$ZodType[];
}

function definition(schema: core.$ZodType): ZodDefShape {
  return schema._zod.def as ZodDefShape;
}

function isJsonValueSchema(schema: core.$ZodType): boolean {
  const def = definition(schema);
  if (def.type !== "lazy" || !def.getter) return false;
  const resolved = def.getter();
  if (resolved._zod.def.type !== "union") return false;
  const options = definition(resolved).options;
  return (
    options?.map((option) => option._zod.def.type).join(",") ===
    "string,number,boolean,null,array,record"
  );
}

function narrowOverride({
  zodSchema,
  jsonSchema,
}: {
  zodSchema: core.$ZodTypes;
  jsonSchema: core.JSONSchema.BaseSchema;
}): void {
  const def = definition(zodSchema);
  if (def.type === "optional" && def.innerType && def.innerType._zod.def.type === "never") {
    for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    jsonSchema[OMIT_OPTIONAL_NEVER] = true;
    return;
  }

  if (isJsonValueSchema(zodSchema)) {
    for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    jsonSchema.description = JSON_VALUE_DESCRIPTION;
  }
}

function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanSchema);
  }
  if (!value || typeof value !== "object") return value;

  const source = value as JsonSchema;
  const cleaned: JsonSchema = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "$schema" || key === "$id" || key === "~standard" || key === OMIT_OPTIONAL_NEVER)
      continue;
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      cleaned.properties = Object.fromEntries(
        Object.entries(child as JsonSchema)
          .filter(
            ([, property]) =>
              !(
                property &&
                typeof property === "object" &&
                (property as JsonSchema)[OMIT_OPTIONAL_NEVER] === true
              ),
          )
          .map(([name, property]) => [name, cleanSchema(property)]),
      );
      continue;
    }
    cleaned[key === "anyOf" ? "oneOf" : key] = cleanSchema(child);
  }
  return cleaned;
}

function mergeInputAndOutput(input: unknown, output: unknown): unknown {
  if (Array.isArray(input) && Array.isArray(output)) {
    return output.map((value, index) => mergeInputAndOutput(input[index], value));
  }
  if (
    input &&
    output &&
    typeof input === "object" &&
    typeof output === "object" &&
    !Array.isArray(input) &&
    !Array.isArray(output)
  ) {
    const inputObject = input as JsonSchema;
    const outputObject = output as JsonSchema;
    const merged: JsonSchema = { ...inputObject };
    for (const [key, value] of Object.entries(outputObject)) {
      merged[key] = key in inputObject ? mergeInputAndOutput(inputObject[key], value) : value;
    }
    if (inputObject.type === "object" && outputObject.type === "object") {
      if ("required" in inputObject) merged.required = inputObject.required;
      else delete merged.required;
    }
    for (const boundary of ["minimum", "exclusiveMinimum"] as const) {
      if (typeof inputObject[boundary] === "number" && typeof outputObject[boundary] === "number") {
        merged[boundary] = Math.max(inputObject[boundary], outputObject[boundary]);
      }
    }
    for (const boundary of ["maximum", "exclusiveMaximum"] as const) {
      if (typeof inputObject[boundary] === "number" && typeof outputObject[boundary] === "number") {
        merged[boundary] = Math.min(inputObject[boundary], outputObject[boundary]);
      }
    }
    return merged;
  }
  return output ?? input;
}

function inlineKnownJsonReferences(root: JsonSchema): JsonSchema {
  const replacements = new Map<string, JsonSchema>();
  const localDefs = root.$defs as JsonSchema | undefined;
  for (const [name, schema] of Object.entries(localDefs ?? {})) {
    if ((schema as JsonSchema).description === JSON_VALUE_DESCRIPTION) {
      replacements.set(`#/$defs/${name}`, schema as JsonSchema);
      delete localDefs?.[name];
    }
  }

  const shared = root.__shared as JsonSchema | undefined;
  const sharedDefs = shared?.$defs as JsonSchema | undefined;
  for (const [name, schema] of Object.entries(sharedDefs ?? {})) {
    if ((schema as JsonSchema).description === JSON_VALUE_DESCRIPTION) {
      replacements.set(`#/components/schemas/__shared#/$defs/${name}`, schema as JsonSchema);
      delete sharedDefs?.[name];
    }
  }

  function replace(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    const object = value as JsonSchema;
    const replacement = typeof object.$ref === "string" ? replacements.get(object.$ref) : undefined;
    if (replacement) {
      const { $ref: _ref, ...siblings } = object;
      return { ...structuredClone(replacement), ...siblings };
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, replace(child)]));
  }

  if (localDefs && Object.keys(localDefs).length === 0) delete root.$defs;
  if (sharedDefs && Object.keys(sharedDefs).length === 0) delete root.__shared;
  return replace(root) as JsonSchema;
}

function appendDescription(schema: JsonSchema, property: string, description: string): void {
  const properties = schema.properties as JsonSchema | undefined;
  const target = properties?.[property] as JsonSchema | undefined;
  if (!target) return;
  target.description = target.description
    ? `${String(target.description)} ${description}`
    : description;
}

function appendDescriptionsInBranches(
  schema: JsonSchema,
  property: string,
  description: string,
  type?: string,
): void {
  appendDescription(schema, property, description);
  const branches = schema.oneOf;
  if (!Array.isArray(branches)) return;
  for (const branch of branches) {
    const target = ((branch as JsonSchema).properties as JsonSchema | undefined)?.[property] as
      JsonSchema | undefined;
    if (!type || target?.type === type)
      appendDescription(branch as JsonSchema, property, description);
  }
}

function describeRequestRefinements(source: ZodType, schema: JsonSchema): void {
  const wellFormed = "Must be a well-formed Unicode string.";
  const author = `${wellFormed} Maximum 200 UTF-8 bytes.`;
  const message = `${wellFormed} Maximum 2000 UTF-8 bytes.`;
  const body = `${wellFormed} Maximum ${MAX_BODY_BYTES} UTF-8 bytes.`;
  const meta = "Serialized JSON must be at most 4096 UTF-8 bytes.";

  if (source === PutFileBody) {
    appendDescription(schema, "body", body);
    appendDescription(schema, "author", author);
    appendDescription(schema, "message", message);
    appendDescription(schema, "meta", meta);
    appendDescription(schema, "contentType", wellFormed);
  } else if (source === DeleteFileBody) {
    appendDescription(schema, "author", author);
    appendDescription(schema, "message", message);
  } else if (source === RollbackBody) {
    appendDescription(schema, "author", author);
    appendDescription(schema, "message", message);
    appendDescription(schema, "meta", meta);
  } else if (source === CreateStashBody) {
    appendDescription(
      schema,
      "name",
      "Must satisfy the stash-name rules: 1-63 lowercase ASCII letters, digits, or hyphens, beginning with a letter or digit.",
    );
    appendDescription(schema, "description", wellFormed);
    appendDescription(schema, "meta", meta);
  } else if (source === CreateTokenBody) {
    appendDescription(schema, "label", wellFormed);
    schema.description = "expiresAt and ttlSeconds are mutually exclusive.";
    appendDescription(schema, "expiresAt", "Mutually exclusive with ttlSeconds.");
    appendDescription(schema, "ttlSeconds", "Mutually exclusive with expiresAt.");
  } else if (source === RotateTokenBody) {
    schema.description = "expiresAt and ttlSeconds are mutually exclusive.";
    appendDescription(schema, "expiresAt", "Mutually exclusive with ttlSeconds.");
    appendDescription(schema, "ttlSeconds", "Mutually exclusive with expiresAt.");
  } else if (source === ChangesQuery) {
    schema.description = "The since and before keyset cursors are mutually exclusive.";
    appendDescription(schema, "since", "Mutually exclusive with before.");
    appendDescription(schema, "before", "Mutually exclusive with since.");
  } else if (source === DiffCandidateBody) {
    appendDescription(schema, "body", body);
  } else if (source === ImportBody) {
    schema.description =
      "Imported createdAt values must be non-decreasing. rollbackOf must name an earlier, non-delete version.";
    appendDescription(
      schema,
      "path",
      "Must satisfy the file-path rules: a non-empty slash-separated path whose segments contain only ASCII letters, digits, dots, underscores, or hyphens and are neither dot nor dot-dot; maximum 512 UTF-8 bytes.",
    );
    const versions = (schema.properties as JsonSchema | undefined)?.versions as
      JsonSchema | undefined;
    const item = versions?.items as JsonSchema | undefined;
    if (item) {
      appendDescriptionsInBranches(item, "body", body, "string");
      appendDescriptionsInBranches(item, "author", author);
      appendDescriptionsInBranches(item, "message", message);
      appendDescriptionsInBranches(item, "meta", meta);
    }
  } else if (source === ListStashesQuery) {
    schema.description = "includeDeleted defaults to false.";
    appendDescription(schema, "includeDeleted", "Whether soft-deleted stashes are included.");
  } else if (source === RunGcBody) {
    schema.description =
      "kind selects the R2-orphan, ledger, or unreferenced-content job. dryRun and maxObjects default to false and 100; maxObjects is an integer from 1 through 500. cursor is an opaque v1 base64url kind-bound envelope.";
    appendDescription(schema, "kind", "Selects the garbage-collection job kind.");
    appendDescription(
      schema,
      "dryRun",
      "Defaults to false; dry runs never delete or persist progress.",
    );
    appendDescription(
      schema,
      "maxObjects",
      "Defaults to 100; accepts integers from 1 through 500.",
    );
    appendDescription(
      schema,
      "cursor",
      "Opaque v1 base64url kind-bound cursor; explicit input overrides stored progress.",
    );
  } else if (source === ListGcRunsQuery) {
    schema.description = "Results are newest first; limit defaults to 50 and has a maximum of 200.";
    appendDescription(schema, "kind", "Optional garbage-collection job-kind filter.");
  } else if (source === CreateCommitBody || source === CreateChangeSetBody) {
    schema.description =
      "Entry paths must be unique and copy.from.path cannot name another entry path.";
    appendDescription(schema, "author", author);
    appendDescription(schema, "message", message);
    appendDescription(
      schema,
      "meta",
      `${meta} commitId and changeSetId are platform-owned and must be absent.`,
    );
  } else if (source === ListChangeSetsQuery) {
    appendDescription(schema, "status", "Use all to disable the status filter.");
  } else if (source === ApproveChangeSetBody || source === RevertCommitBody) {
    appendDescription(schema, "author", author);
    appendDescription(schema, "message", message);
  } else if (source === RejectChangeSetBody) {
    appendDescription(schema, "reason", message);
  } else if (source === CommitDiffQuery || source === ChangeSetDiffQuery) {
    appendDescription(schema, "context", "Optional non-negative diff context line count.");
  }
}

const conversionOptions = {
  target: "draft-2020-12" as const,
  override: narrowOverride,
} satisfies core.ToJSONSchemaParams;

/** Projects all response schemas in one registry pass so component references share one root. */
export function projectResponseSchemas(): Record<string, JsonSchema> {
  const registry = z.registry<{ id?: string }>();
  for (const [name, schema] of Object.entries(RESPONSE_SCHEMAS)) {
    registry.add(schema, { id: name });
  }
  const result = z.toJSONSchema(registry, {
    ...conversionOptions,
    uri: (id) => `#/components/schemas/${id}`,
  });
  const schemas = Object.fromEntries(
    Object.entries(result.schemas).map(([name, schema]) => [
      name,
      cleanSchema(schema) as JsonSchema,
    ]),
  );
  return inlineKnownJsonReferences(schemas) as Record<string, JsonSchema>;
}

/** Projects request input presence and output constraints, then combines both views. */
export function projectRequestSchema(schema: ZodType): JsonSchema {
  const input = cleanSchema(z.toJSONSchema(schema, { ...conversionOptions, io: "input" }));
  const output = cleanSchema(z.toJSONSchema(schema, { ...conversionOptions, io: "output" }));
  const projected = inlineKnownJsonReferences(mergeInputAndOutput(input, output) as JsonSchema);
  describeRequestRefinements(schema, projected);
  return projected;
}
