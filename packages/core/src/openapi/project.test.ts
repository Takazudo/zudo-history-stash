import { expect, it } from "vitest";
import { CreateChangeSetBody, CreateCommitBody } from "../schemas.js";
import { projectRequestSchema, projectResponseSchemas } from "./project.js";

it("projects the new request and response lattice", () => {
  for (const schema of [CreateCommitBody, CreateChangeSetBody]) {
    const projected = projectRequestSchema(schema);
    expect(projected).toHaveProperty("properties.entries");
    expect(projected.description).toContain("Entry paths must be unique");
  }
  expect(projectResponseSchemas()).toHaveProperty("CommitRecord");
  expect(projectResponseSchemas()).toHaveProperty("ChangeSetRecord");
});
