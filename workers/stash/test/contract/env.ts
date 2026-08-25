export type TestTier = "local" | "preview" | "production";

type RuntimeEnvironment = Record<string, string | undefined>;

function runtimeEnvironment(): RuntimeEnvironment {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: RuntimeEnvironment };
  };
  return runtime.process?.env ?? {};
}

export function parseTestTier(value: string | undefined): TestTier {
  const tier = value ?? "local";
  if (tier === "local" || tier === "preview" || tier === "production") return tier;
  throw new Error(`TEST_TIER must be local, preview, or production; received ${tier}`);
}

export function mutationAllowedFor(tier: TestTier): boolean {
  return tier === "local";
}

const environment = runtimeEnvironment();

export const TEST_TIER = parseTestTier(environment.TEST_TIER);
export const MUTATION_ALLOWED = mutationAllowedFor(TEST_TIER);
export const API_BASE_URL = (environment.API_BASE_URL ?? "http://localhost:8787").replace(
  /\/+$/u,
  "",
);
export const STASH_ADMIN_TOKEN =
  environment.STASH_ADMIN_TOKEN ?? (TEST_TIER === "local" ? "dev-admin-token" : "");
export const SEEDED_STASH = environment.CONTRACT_STASH_NAME ?? "demo";
export const SEEDED_PATH = environment.CONTRACT_FILE_PATH ?? "docs/guide.md";

export function requireAdminToken(): string {
  if (STASH_ADMIN_TOKEN !== "") return STASH_ADMIN_TOKEN;
  throw new Error(`STASH_ADMIN_TOKEN is required for the ${TEST_TIER} contract tier`);
}
