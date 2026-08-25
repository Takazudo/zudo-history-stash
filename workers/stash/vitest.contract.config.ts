import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/contract/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 20_000,
  },
});
