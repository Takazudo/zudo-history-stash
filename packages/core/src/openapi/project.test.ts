import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_BODY_BYTES } from "../limits.js";
import {
  CreateTokenBody,
  DiffQuery,
  ImportBody,
  ListFilesQuery,
  ListQuery,
  PutFileBody,
  RotateTokenBody,
} from "../schemas.js";
import { projectRequestSchema, projectResponseSchemas } from "./project.js";

const propertiesOf = (schema: Record<string, unknown>) =>
  schema.properties as Record<string, Record<string, unknown>>;

describe("projectRequestSchema", () => {
  it("combines input optionality with output defaults and constraints", () => {
    const list = projectRequestSchema(ListQuery);
    expect(list.required ?? []).not.toContain("limit");
    expect(propertiesOf(list).limit).toMatchObject({
      type: "integer",
      default: 50,
      minimum: 1,
      maximum: 200,
    });

    const files = projectRequestSchema(ListFilesQuery);
    expect(files.required ?? []).not.toContain("includeDeleted");
    expect(propertiesOf(files).includeDeleted).toMatchObject({ type: "boolean", default: false });
  });

  it("uses oneOf for regular and discriminated unions", () => {
    const diff = projectRequestSchema(DiffQuery);
    expect(propertiesOf(diff).to!.oneOf).toEqual([
      expect.objectContaining({ type: "integer" }),
      { type: "string", const: "head" },
    ]);

    const imported = projectRequestSchema(ImportBody);
    const versions = propertiesOf(imported).versions!;
    const branches = (versions.items as Record<string, unknown>).oneOf as Array<
      Record<string, unknown>
    >;
    expect(branches).toHaveLength(3);
    expect(
      branches.map(
        (branch) =>
          (branch.properties as Record<string, Record<string, unknown>>).kind!.const as string,
      ),
    ).toEqual(["put", "delete", "rollback"]);
    for (const branch of branches) {
      expect(branch.properties).not.toHaveProperty("rollbackOf.not");
    }
  });

  it("documents token expiry exclusivity and rotation defaults", () => {
    const create = projectRequestSchema(CreateTokenBody);
    expect(create.description).toBe("expiresAt and ttlSeconds are mutually exclusive.");
    expect(propertiesOf(create).expiresAt).toMatchObject({
      type: "string",
      format: "date-time",
      description: "Mutually exclusive with ttlSeconds.",
    });
    expect(propertiesOf(create).ttlSeconds).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 315_360_000,
      description: "Mutually exclusive with expiresAt.",
    });

    const rotate = projectRequestSchema(RotateTokenBody);
    expect(rotate.description).toBe("expiresAt and ttlSeconds are mutually exclusive.");
    expect(rotate.required ?? []).not.toContain("graceSeconds");
    expect(propertiesOf(rotate).graceSeconds).toMatchObject({
      type: "integer",
      default: 300,
      minimum: 0,
      maximum: 86_400,
    });
    expect(propertiesOf(rotate).expiresAt?.description).toBe("Mutually exclusive with ttlSeconds.");
    expect(propertiesOf(rotate).ttlSeconds?.description).toBe("Mutually exclusive with expiresAt.");
  });

  it("handles only the deliberate escape hatches and fails on new unrepresentables", () => {
    const schema = projectRequestSchema(z.object({ json: z.json(), absent: z.never().optional() }));
    expect(propertiesOf(schema).json).toEqual({
      description:
        "Any JSON value. The recursive z.json() validator is intentionally represented as an unconstrained schema.",
    });
    expect(propertiesOf(schema)).not.toHaveProperty("absent");
    expect(() => projectRequestSchema(z.object({ date: z.date() }))).toThrow(
      "Date cannot be represented",
    );
  });

  it("projects PutFileBody deterministically", () => {
    const projected = projectRequestSchema(PutFileBody);
    expect(propertiesOf(projected).body?.description).toContain(String(MAX_BODY_BYTES));
    expect(projected).toMatchSnapshot();
  });
});

describe("projectResponseSchemas", () => {
  it("uses component-root references without local definition references", () => {
    const schemas = projectResponseSchemas();
    const serialized = JSON.stringify(schemas);
    expect(serialized).not.toContain("#/$defs");
    expect(serialized).not.toContain("#/definitions");
    expect(serialized).toContain("#/components/schemas/");
  });
});
