import {
  createStashClient,
  type ClientResult,
  type StashClient,
} from "@takazudo/zudo-history-stash";
import { API_BASE_URL, requireAdminToken } from "./env.js";

export function createAdminClient(): StashClient {
  return createStashClient({ baseUrl: API_BASE_URL, token: requireAdminToken() });
}

export function unwrap<T>(result: ClientResult<T>, operation: string): T {
  if (result.ok) return result.value;
  throw new Error(
    `${operation} failed (${result.error.status} ${result.error.code}): ${result.error.message}`,
  );
}

export function uniqueStash(label: string): string {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `contract-${label}-${suffix}`;
}
