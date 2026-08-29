import { describe, expect, it } from "vitest";
import { ROUTES } from "../routes.js";
import { buildOpenApiDocument } from "./document.js";

describe("OpenAPI document", () => {
  it("contains all 49 operations deterministically", () => {
    const document = buildOpenApiDocument({ version: "test" });
    expect(document).toEqual(buildOpenApiDocument({ version: "test" }));
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
    expect(operations).toHaveLength(49);
    expect(new Set(operations.map(({ operationId }) => operationId))).toEqual(new Set(ROUTES.map(({ id }) => id)));
  });
  it("documents the new route families", () => {
    const paths = buildOpenApiDocument({ version: "test" }).paths;
    expect(paths["/v1/stashes/{stash}/commits"]?.post?.operationId).toBe("createCommit");
    expect(paths["/v1/stashes/{stash}/snapshot"]?.get?.operationId).toBe("getSnapshot");
    expect(paths["/v1/stashes/{stash}/change-sets/{id}/approve"]?.post?.operationId).toBe("approveChangeSet");
  });
});
