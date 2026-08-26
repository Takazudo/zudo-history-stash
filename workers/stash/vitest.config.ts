import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          STASH_ADMIN_TOKEN: "test-admin",
          ALLOWED_ORIGINS: "http://localhost:5173",
        },
        serviceBindings: {
          STASH_RPC: { name: "zudo-history-stash", entrypoint: "StashRpc" },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/contract/**"],
    setupFiles: ["./test/setup.ts"],
    maxWorkers: 2,
  },
});
