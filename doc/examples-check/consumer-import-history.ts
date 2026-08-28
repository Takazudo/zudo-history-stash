import {
  createStashClient,
  type ClientResult,
  type ImportVersion,
  validatePath,
} from "@takazudo/zudo-history-stash";

function valueOf<T>(result: ClientResult<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed: ${result.error.code}`);
  }
  return result.value;
}

export async function importOrderedHistory(input: {
  baseUrl: string;
  adminToken: string;
  stash: string;
  path: string;
  firstCreatedAt: number;
}) {
  if (!validatePath(input.path).ok) {
    throw new Error("The import path is invalid.");
  }
  if (
    !Number.isSafeInteger(input.firstCreatedAt) ||
    input.firstCreatedAt < 0 ||
    input.firstCreatedAt + 4 > Date.now()
  ) {
    throw new Error("firstCreatedAt must leave five historical millisecond timestamps.");
  }

  const admin = createStashClient({ baseUrl: input.baseUrl, token: input.adminToken });
  const firstBatch: ImportVersion[] = [
    { kind: "put", body: "first\n", createdAt: input.firstCreatedAt },
    { kind: "put", body: "second\n", createdAt: input.firstCreatedAt + 1 },
    { kind: "delete", body: null, createdAt: input.firstCreatedAt + 2 },
    {
      kind: "rollback",
      body: null,
      rollbackOf: 2,
      createdAt: input.firstCreatedAt + 3,
    },
  ];
  const first = valueOf(
    await admin.stashes.import(input.stash, {
      path: input.path,
      expectedVersion: null,
      versions: firstBatch,
    }),
    "import first batch",
  );

  const second = valueOf(
    await admin.stashes.import(input.stash, {
      path: input.path,
      expectedVersion: first.headVersion,
      versions: [{ kind: "put", body: "third\n", createdAt: input.firstCreatedAt + 4 }],
    }),
    "import second batch",
  );

  return { first, second };
}
