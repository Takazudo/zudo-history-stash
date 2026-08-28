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
const previewHarness = process.env.PW_PREVIEW === "1";
if (liveHarness && previewHarness) throw new Error("PW_LIVE and PW_PREVIEW are mutually exclusive");

export function resolvePreviewBaseUrl(value: string | undefined): string {
  if (!value) throw new Error("chromium-preview requires PW_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("chromium-preview requires PW_BASE_URL to be an HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("chromium-preview requires PW_BASE_URL to be an HTTPS origin");
  }
  return parsed.origin;
}

if (previewHarness && !/^zhs_[A-Za-z0-9_-]+$/u.test(process.env.PW_STASH_TOKEN ?? "")) {
  throw new Error("chromium-preview requires PW_STASH_TOKEN");
}

const baseURL = previewHarness
  ? resolvePreviewBaseUrl(externalBaseUrl)
  : resolveViewerBaseUrl(externalBaseUrl, liveHarness);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: previewHarness ? 1 : resolveWorkers(process.env.PW_WORKERS),
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
      testIgnore: /preview\.smoke\.spec\.ts/u,
      grepInvert: /@live|@preview|@local-only|@flaky/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-live",
      testMatch: /live\.spec\.ts/u,
      testIgnore: /preview\.smoke\.spec\.ts/u,
      grep: /@live/u,
      grepInvert: /@preview|@local-only|@flaky/u,
      use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
    },
    ...(previewHarness
      ? [
          {
            name: "chromium-preview",
            testMatch: /preview\.smoke\.spec\.ts/u,
            grep: /@preview/u,
            retries: 0,
            fullyParallel: false,
            use: { ...devices["Desktop Chrome"], trace: "off" as const },
          },
        ]
      : []),
  ],
});
