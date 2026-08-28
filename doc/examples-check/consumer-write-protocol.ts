import { createStashClient } from "@takazudo/zudo-history-stash";

export async function writeWithCompareAndSet(input: {
  baseUrl: string;
  writeToken: string;
  stash: string;
  path: string;
  body: string;
  stableIdempotencyKey: string;
  ifNoneMatch?: string;
}) {
  const client = createStashClient({ baseUrl: input.baseUrl, token: input.writeToken });
  const files = client.files(input.stash);
  const snapshot = await files.get(input.path, { ifNoneMatch: input.ifNoneMatch });

  if (snapshot.ok && "notModified" in snapshot) {
    return { kind: "not-modified" as const };
  }

  let expectedVersion: number | null;
  if (snapshot.ok) {
    expectedVersion = snapshot.value.version;
  } else if (snapshot.error.code === "not-found") {
    expectedVersion = null;
  } else if (snapshot.error.code === "file-deleted" && snapshot.current) {
    expectedVersion = snapshot.current.version;
  } else {
    return { kind: "read-failed" as const, failure: snapshot };
  }

  const written = await files.put(
    input.path,
    { body: input.body, expectedVersion },
    { idempotencyKey: input.stableIdempotencyKey },
  );
  if (!written.ok && written.error.code === "stale") {
    return { kind: "stale" as const, current: written.current };
  }
  if (!written.ok) {
    return { kind: "write-failed" as const, failure: written };
  }
  return { kind: "written" as const, value: written.value, replayed: written.replayed === true };
}

export async function replaceLatestForSimpleIntent(input: {
  baseUrl: string;
  writeToken: string;
  stash: string;
  path: string;
  body: string;
}) {
  const client = createStashClient({ baseUrl: input.baseUrl, token: input.writeToken });
  const result = await client.putLatest(input.stash, input.path, input.body, { retries: 3 });
  if (!result.ok) {
    return { kind: "failed" as const, failure: result };
  }
  return { kind: "written" as const, value: result.value };
}
