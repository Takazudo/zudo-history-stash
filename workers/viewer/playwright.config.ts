import { defineConfig, devices } from "@playwright/test";

export function resolveWorkers(value: string | undefined): number | `${number}%` | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^[1-9]\d*$/u.test(value)) return Number.parseInt(value, 10);
  if (/^(100|[1-9]\d?)%$/u.test(value)) return value as `${number}%`;
  throw new Error(`PW_WORKERS must be a positive integer or percentage, received: ${value}`);
}

const externalBaseUrl = process.env.PW_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: resolveWorkers(process.env.PW_WORKERS),
  reporter: [["list"]],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "pnpm dev --host 127.0.0.1 --port 5173",
        url: "http://127.0.0.1:5173/login",
        reuseExistingServer: !process.env.CI,
      },
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:5173",
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
      grep: /@live/u,
      grepInvert: /@local-only|@flaky/u,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
