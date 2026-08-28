import {
  createStashClient,
  type GcKind,
  type GcRunResult,
  type StashClient,
} from "@takazudo/zudo-history-stash";

async function runPass(input: {
  client: StashClient;
  kind: GcKind;
  dryRun: boolean;
  maxObjects: number;
  inspect: (page: GcRunResult) => void;
}) {
  let cursor: string | undefined;
  do {
    const result = await input.client.admin.gc.run({
      kind: input.kind,
      dryRun: input.dryRun,
      maxObjects: input.maxObjects,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.ok && result.error.code === "gc-busy") {
      return { kind: "busy" as const };
    }
    if (!result.ok) {
      return { kind: "failed" as const, failure: result };
    }

    input.inspect(result.value);
    if (result.value.error !== null) {
      return { kind: "failed-page" as const, error: result.value.error };
    }
    cursor = result.value.cursor ?? undefined;
  } while (cursor !== undefined);

  return { kind: "complete" as const };
}

export async function collectGarbageSafely(input: {
  baseUrl: string;
  adminToken: string;
  kind: GcKind;
  maxObjects: number;
  inspect: (page: GcRunResult) => void;
}) {
  const client = createStashClient({ baseUrl: input.baseUrl, token: input.adminToken });
  const dryRun = await runPass({ ...input, client, dryRun: true });
  if (dryRun.kind !== "complete") {
    return { phase: "dry-run" as const, outcome: dryRun };
  }

  const live = await runPass({ ...input, client, dryRun: false });
  return { phase: "live" as const, outcome: live };
}
