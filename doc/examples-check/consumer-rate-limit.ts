import { createStashClient } from "@takazudo/zudo-history-stash";

export async function readHistoryWithRateLimitRetry(input: {
  baseUrl: string;
  readToken: string;
  stash: string;
  path: string;
  sleep: (milliseconds: number) => Promise<void>;
}) {
  const client = createStashClient({ baseUrl: input.baseUrl, token: input.readToken });
  const read = () => client.files(input.stash).history(input.path);
  const first = await read();

  if (first.ok) {
    return { kind: "history" as const, value: first.value };
  }
  if (first.error.code !== "rate-limited" || first.retryAfter === undefined) {
    return { kind: "failed" as const, failure: first };
  }

  await input.sleep(first.retryAfter * 1_000);
  const retry = await read();
  if (!retry.ok) {
    return { kind: "failed" as const, failure: retry };
  }
  return { kind: "history" as const, value: retry.value };
}
