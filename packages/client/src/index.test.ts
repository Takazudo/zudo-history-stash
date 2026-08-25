import { expect, it } from "vitest";
import { VERSION } from "./index.js";

it("exposes the scaffold version", () => {
  expect(VERSION).toBe("0.0.0");
});
