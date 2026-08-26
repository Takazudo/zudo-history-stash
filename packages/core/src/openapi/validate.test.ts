import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./index.js";

describe("OpenAPI document", () => {
  it("passes Scalar validation", async () => {
    const result = await validate(buildOpenApiDocument());

    expect(result.valid).toBe(true);
    expect(result.errors ?? []).toEqual([]);
  });
});
