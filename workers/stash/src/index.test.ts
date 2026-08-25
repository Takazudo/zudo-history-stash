import { expect, it } from "vitest";
import worker from "./index.js";

it("exports a Worker fetch handler", () => {
  expect(typeof worker.fetch).toBe("function");
});
