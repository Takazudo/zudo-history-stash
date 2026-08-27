import { defineConfig, devices } from "@playwright/test";
import { resolveViewerBaseUrl } from "./e2e/live-safety.js";

export function resolveWorkers(value: string | undefined): number | `${number}%` | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^[1-9]\d*$/u.test(value)) return Number.parseInt(value, 10);
  if (/^(100|[1-9]\d?)%$/u.test(value)) return value as `${number}%`;
  throw new Error(`PW_WORKERS must be a positive integer or percentage, received: ${value}`);
}

const externalBaseUrl = process.env.PW_BASE_URL;
const liveHarness = process.env.PW_LIVE === "1";
const baseURL = resolveViewerBaseUrl(externalBaseUrl, liveHarness);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: resolveWorkers(process.env.PW_WORKERS),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  webServer: externalBaseUrl
    ? undefined
    : liveHarness
      ? {
          command: "pnpm --dir ../.. dev:full:seeded",
          url: "http://localhost:8787/api/v1/health",
          reuseExistingServer: false,
          timeout: 120_000,
        }
      : {
          command: "pnpm dev --host 127.0.0.1 --port 5173",
          url: "http://127.0.0.1:5173/login",
          reuseExistingServer: !process.env.CI,
        },
  use: {
    baseURL,
    contextOptions: { reducedMotion: "reduce" },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@live|@local-only|@flaky/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-live",
      testMatch: /live\.spec\.ts/u,
      grep: /@live/u,
      grepInvert: /@local-only|@flaky/u,
      use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    },
  ],
});
