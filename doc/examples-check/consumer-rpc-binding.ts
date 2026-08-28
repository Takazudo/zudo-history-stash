import {
  createStashClient,
  StashHttpError,
  type StashRpcEntrypoint,
} from "@takazudo/zudo-history-stash";

export async function readThroughRpc(input: {
  binding: StashRpcEntrypoint;
  token: string;
  stash: string;
  path: string;
}) {
  const client = createStashClient({
    transport: { kind: "rpc", binding: input.binding, token: input.token },
  });

  try {
    const result = await client.files(input.stash).get(input.path);
    if (result.ok && "notModified" in result) {
      return { kind: "not-modified" as const };
    }
    if (!result.ok) {
      return { kind: "business-failure" as const, failure: result };
    }
    return { kind: "file" as const, value: result.value };
  } catch (error) {
    if (error instanceof StashHttpError && error.status === 0) {
      throw new Error("The RPC binding call was rejected before an HTTP response existed.", {
        cause: error,
      });
    }
    throw error;
  }
}
