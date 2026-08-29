import {
  createStashClient,
  type FileGetResult,
  type StashRpcEntrypoint,
} from "@takazudo/zudo-history-stash";
import { runRpcMultipartSmoke } from "./multipart-smoke.js";

export interface Env {
  STASH: Fetcher;
  STASH_RPC: StashRpcEntrypoint;
  STASH_TOKEN: string;
  RPC_SMOKE_TRIGGER_TOKEN?: string;
  MULTIPART_SMOKE_STASH?: string;
}

export const DEMO_STASH = "example-rpc-demo";
export const DEMO_PATH = "demo.txt";
export const BINARY_DEMO_PATH = "demo.bin";
const DEMO_BODY = "Written by the example RPC consumer.\n";
const GATED_PATHS = new Set(["/demo", "/binary-demo", "/multipart-smoke"]);

function versionForPut(get: FileGetResult): number | null | undefined {
  if (get.ok) return "value" in get ? get.value.version : undefined;
  if (get.error.code === "not-found") return null;
  return get.current?.version;
}

function rollbackTarget(get: FileGetResult, putVersion: number): number {
  if (get.ok && "value" in get) return get.value.version;
  return putVersion;
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let different = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    different |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return different === 0;
}

function triggerGate(request: Request, env: Env): Response | null {
  const triggerToken = env.RPC_SMOKE_TRIGGER_TOKEN;
  if (triggerToken === undefined || triggerToken.length === 0) {
    return new Response("Not found", { status: 404 });
  }
  if (!timingSafeTextEqual(request.headers.get("Authorization") ?? "", `Bearer ${triggerToken}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

/**
 * Demonstrates one typed RPC client sequence. It is exported so hosts can test the consumer
 * without deploying this example Worker.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!GATED_PATHS.has(url.pathname)) return new Response("Not found", { status: 404 });
  const gated = triggerGate(request, env);
  if (gated !== null) return gated;
  if (url.pathname === "/multipart-smoke") {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    try {
      return Response.json(await runRpcMultipartSmoke(env));
    } catch {
      return Response.json({ ok: false, checks: [] }, { status: 500 });
    }
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  }

  const client = createStashClient({
    transport: { kind: "rpc", binding: env.STASH_RPC, token: env.STASH_TOKEN },
  });
  if (url.pathname === "/binary-demo") {
    const files = client.files(DEMO_STASH);
    const current = await files.get(BINARY_DEMO_PATH);
    const expectedVersion = versionForPut(current);
    if (expectedVersion === undefined) return Response.json({ current }, { status: 500 });
    const uploaded = await files.upload(
      BINARY_DEMO_PATH,
      new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]),
      {
        expectedVersion,
        representation: "binary",
        contentType: "application/octet-stream",
        idempotencyKey: `example-rpc-binary-${expectedVersion ?? "new"}`,
      },
    );
    if (!uploaded.ok) return Response.json({ uploaded }, { status: uploaded.error.status });
    const downloaded = await files.raw.get(BINARY_DEMO_PATH);
    if (!downloaded.ok || "notModified" in downloaded)
      return Response.json({ downloaded }, { status: 500 });
    const bytes = await downloaded.value.bytes(64);
    return Response.json({ uploaded, bytes: [...bytes] });
  }
  const files = client.files(DEMO_STASH);
  const get = await files.get(DEMO_PATH);
  const expectedVersion = versionForPut(get);
  const put =
    expectedVersion === undefined
      ? {
          ok: false as const,
          error: { code: "internal", status: 500, message: "Demo read failed" },
        }
      : await files.put(
          DEMO_PATH,
          { body: DEMO_BODY, expectedVersion, skipIfUnchanged: true },
          { idempotencyKey: `example-rpc-demo-put-${expectedVersion ?? "new"}` },
        );
  const history = await files.history(DEMO_PATH);
  const rollback =
    put.ok && history.ok
      ? await files.rollback(
          DEMO_PATH,
          {
            expectedVersion: put.value.version,
            toVersion: rollbackTarget(get, put.value.version),
          },
          {
            idempotencyKey: `example-rpc-demo-rollback-${put.value.version}-${rollbackTarget(
              get,
              put.value.version,
            )}`,
          },
        )
      : {
          ok: false as const,
          error: { code: "internal", status: 500, message: "Demo write or history failed" },
        };

  const commits = client.commits(DEMO_STASH);
  const commitList = await commits.list({ limit: 1 });
  const latestCommitId =
    commitList.ok && commitList.value.commits[0] !== undefined
      ? commitList.value.commits[0].id
      : undefined;
  const commit = latestCommitId === undefined ? null : await commits.get(latestCommitId);
  const commitDiff = latestCommitId === undefined ? null : await commits.diff(latestCommitId);
  const snapshot =
    latestCommitId === undefined ? null : await files.snapshot({ at: `commit:${latestCommitId}` });

  const changeSets = client.changeSets(DEMO_STASH);
  const changeSetList = await changeSets.list({ status: "all", limit: 1 });
  const latestChangeSetId =
    changeSetList.ok && changeSetList.value.changeSets[0] !== undefined
      ? changeSetList.value.changeSets[0].id
      : undefined;
  const changeSet =
    latestChangeSetId === undefined ? null : await changeSets.get(latestChangeSetId);
  const changeSetDiff =
    latestChangeSetId === undefined ? null : await changeSets.diff(latestChangeSetId);

  return Response.json({
    get,
    put,
    history,
    rollback,
    commits: { list: commitList, get: commit, diff: commitDiff },
    snapshot,
    changeSets: { list: changeSetList, get: changeSet, diff: changeSetDiff },
  });
}

export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
