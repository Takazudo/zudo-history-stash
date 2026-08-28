import {
  createStashClient,
  type ClientResult,
  validatePath,
  validateStashName,
} from "@takazudo/zudo-history-stash";

function valueOf<T>(result: ClientResult<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed: ${result.error.code}`);
  }
  return result.value;
}

export async function runFreshStashQuickstart(input: { baseUrl: string; adminToken: string }) {
  const admin = createStashClient({ baseUrl: input.baseUrl, token: input.adminToken });
  const stash = `guide-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const path = "docs/guide.md";

  if (!validateStashName(stash).ok || !validatePath(path).ok) {
    throw new Error("The generated quickstart target is invalid.");
  }

  const created = valueOf(
    await admin.stashes.create({ name: stash, description: "Fresh SDK quickstart" }),
    "create stash",
  );
  const credential = valueOf(
    await admin.stashes.tokens(stash).create({
      label: "quickstart",
      scope: "write",
      ttlSeconds: 3_600,
    }),
    "create write token",
  );

  const writer = createStashClient({ baseUrl: input.baseUrl, token: credential.token });
  const files = writer.files(stash);
  const version1 = valueOf(
    await files.put(path, {
      body: "# Guide\n\nFirst version.\n",
      expectedVersion: null,
      message: "Create the guide",
    }),
    "write version 1",
  );
  const version2 = valueOf(
    await files.put(path, {
      body: "# Guide\n\nSecond version.\n",
      expectedVersion: version1.version,
      message: "Revise the guide",
    }),
    "write version 2",
  );

  const history = valueOf(await files.history(path), "read history");
  const diff = valueOf(
    await files.diff(path, { from: version1.version, to: version2.version }),
    "diff versions",
  );
  const rollback = valueOf(
    await files.rollback(path, {
      toVersion: version1.version,
      expectedVersion: version2.version,
      message: "Restore the first version",
    }),
    "roll back",
  );

  return { created, history, diff, rollback };
}
