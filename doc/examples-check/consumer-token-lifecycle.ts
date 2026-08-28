import { createStashClient, type ClientResult } from "@takazudo/zudo-history-stash";

function valueOf<T>(result: ClientResult<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed: ${result.error.code}`);
  }
  return result.value;
}

export async function rotateAndRevokeToken(input: {
  baseUrl: string;
  adminToken: string;
  stash: string;
  storeSecret: (tokenId: string, secret: string) => Promise<void>;
}) {
  const admin = createStashClient({ baseUrl: input.baseUrl, token: input.adminToken });
  const tokens = admin.stashes.tokens(input.stash);
  const predecessor = valueOf(
    await tokens.create({ label: "automation", scope: "write", ttlSeconds: 3_600 }),
    "create token",
  );
  await input.storeSecret(predecessor.id, predecessor.token);

  const successor = valueOf(
    await tokens.rotate(predecessor.id, { graceSeconds: 30 }),
    "rotate token",
  );
  await input.storeSecret(successor.id, successor.token);

  valueOf(await tokens.revoke(successor.id), "revoke successor");
  return { predecessorId: predecessor.id, successorId: successor.id };
}
