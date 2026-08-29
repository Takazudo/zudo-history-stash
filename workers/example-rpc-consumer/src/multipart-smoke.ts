import {
  createStashClient,
  type ClientResult,
  type StashRpcEntrypoint,
  type StashUploadSessionsClient,
} from "@takazudo/zudo-history-stash";

const MIN_REAL_R2_PART_BYTES = 5 * 1024 * 1024;
const MAX_SMOKE_PART_BYTES = 16 * 1024 * 1024;
const MAX_SMOKE_FILE_BYTES = 64 * 1024 * 1024;
const FIXTURE_CHUNK_BYTES = 64 * 1024;
const TERMINAL_UPLOAD_STATES = new Set(["committed", "aborted", "expired", "stale", "failed"]);
// Twenty inter-attempt waits total 35.75s, covering the Worker's 30s part/finalization lease.
const CLEANUP_ATTEMPTS = 21;

export interface MultipartSmokeEnv {
  STASH_RPC: StashRpcEntrypoint;
  STASH_TOKEN: string;
  MULTIPART_SMOKE_STASH?: string;
}

export interface MultipartSmokeResult {
  ok: true;
  checks: string[];
}

interface CleanupSession {
  id: string;
  generation: number;
  key: string;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function value<T>(result: ClientResult<T>, operation: string): T {
  if (!result.ok) throw new Error(`${operation} failed (${result.error.code})`);
  return result.value;
}

function fixtureBytes(start: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = ((start + index) * 31 + 17) % 251;
  }
  return bytes;
}

function fixtureStream(start: number, length: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === length) {
        controller.close();
        return;
      }
      const chunkLength = Math.min(FIXTURE_CHUNK_BYTES, length - offset);
      controller.enqueue(fixtureBytes(start + offset, chunkLength));
      offset += chunkLength;
    },
  });
}

function digestHex(digest: ArrayBuffer): string {
  return `sha256-${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function digestStream(): DigestStream {
  const runtimeCrypto = crypto as Crypto & { DigestStream: typeof DigestStream };
  return new runtimeCrypto.DigestStream("SHA-256");
}

function cleanupDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2_000)));
}

export async function confirmRpcSmokeSessionTerminal(
  uploads: Pick<StashUploadSessionsClient, "abort" | "status">,
  session: CleanupSession,
  options: {
    attempts?: number;
    wait?: (attempt: number) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = options.attempts ?? CLEANUP_ATTEMPTS;
  const wait = options.wait ?? cleanupDelay;
  let failure: unknown = new Error("RPC smoke session cleanup failed");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const aborted = await uploads.abort(session.id, session.generation, {
        idempotencyKey: session.key,
      });
      if (aborted.ok) return;
      failure = new Error(`RPC smoke session abort failed (${aborted.error.code})`);
      if (aborted.error.status === 409 || aborted.error.status === 410) {
        const status = await uploads.status(session.id);
        if (status.ok && TERMINAL_UPLOAD_STATES.has(status.value.state)) return;
        failure = status.ok
          ? new Error(`RPC smoke session remained ${status.value.state}`)
          : new Error(`RPC smoke session status failed (${status.error.code})`);
      } else if (aborted.error.status < 500) {
        break;
      }
    } catch (error) {
      failure = error;
    }
    if (attempt + 1 < attempts) await wait(attempt);
  }
  throw failure;
}

export async function cleanupRpcSmokeResources<T>(
  sessions: readonly T[],
  cleanupSession: (session: T) => Promise<void>,
  cleanupPath: () => Promise<void>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const session of sessions) {
    try {
      await cleanupSession(session);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) {
    try {
      await cleanupPath();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function fixtureHash(size: number): Promise<string> {
  const digest = digestStream();
  await fixtureStream(0, size).pipeTo(digest);
  expect(Number(digest.bytesWritten) === size, "fixture digest byte count changed");
  return digestHex(await digest.digest);
}

async function streamedHash(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ hash: string; size: number }> {
  expect(body !== null, "raw response did not provide a body stream");
  const digest = digestStream();
  await body.pipeTo(digest);
  return { hash: digestHex(await digest.digest), size: Number(digest.bytesWritten) };
}

/**
 * Runs only behind the bearer-gated remote-dev route. It proves that raw bodies traverse the
 * named entrypoint's flow-controlled Request/Response bridge rather than serialized RPC values.
 */
export async function runRpcMultipartSmoke(env: MultipartSmokeEnv): Promise<MultipartSmokeResult> {
  const stash = env.MULTIPART_SMOKE_STASH?.trim();
  expect(stash, "MULTIPART_SMOKE_STASH is required");
  expect(env.STASH_TOKEN.length > 0, "STASH_TOKEN is required");
  expect(env.STASH_RPC.requestStream !== undefined, "StashRpc requestStream bridge is required");

  let requestStreamCalls = 0;
  let byteRouteFallbacks = 0;
  const binding = {
    request(init: Parameters<StashRpcEntrypoint["request"]>[0]) {
      if (
        init.path === "/v1/capabilities" ||
        init.path.includes("/raw/") ||
        init.path.includes("/uploads/")
      ) {
        byteRouteFallbacks += 1;
      }
      return env.STASH_RPC.request(init);
    },
    requestStream(request: Request, token: string) {
      requestStreamCalls += 1;
      return env.STASH_RPC.requestStream!(request, token);
    },
  };
  const client = createStashClient({
    transport: { kind: "rpc", binding, token: env.STASH_TOKEN },
  });
  const files = client.files(stash);
  const capabilities = value(await client.capabilities(), "capabilities");
  const partSize = capabilities.limits.multipartPartBytes;
  expect(
    partSize >= MIN_REAL_R2_PART_BYTES && partSize <= MAX_SMOKE_PART_BYTES,
    "real-R2 multipart part size is outside the 5..16 MiB smoke range",
  );
  const size = Math.max(capabilities.limits.singleUploadMaxBytes + 1, partSize + 1);
  expect(size <= capabilities.limits.maxFileBytes, "deployment cannot select multipart for smoke");
  expect(size <= MAX_SMOKE_FILE_BYTES, "refusing an RPC smoke fixture above 64 MiB");
  expect(Math.ceil(size / partSize) <= capabilities.limits.maxMultipartParts, "too many parts");

  const nonce = crypto.randomUUID();
  const path = `rpc-multipart-smoke/${Date.now()}-${nonce}.bin`;
  const abandonedPath = `rpc-multipart-smoke/${Date.now()}-${crypto.randomUUID()}-abort.bin`;
  const expectedHash = await fixtureHash(size);
  let liveVersion: number | null = null;
  const cleanupSessions: CleanupSession[] = [];
  let smokeFailure: unknown = null;
  let cleanupFailures: unknown[] = [];

  try {
    const created = value(
      await files.uploads.create(path, {
        expectedVersion: null,
        size,
        hash: expectedHash,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "multipart",
        resumable: true,
        idempotencyKey: `rpc-smoke-create-${nonce}`,
      }),
      "create multipart session",
    );
    cleanupSessions.push({
      id: created.id,
      generation: created.attemptGeneration,
      key: `rpc-smoke-abort-${nonce}`,
    });
    expect(created.mode === "multipart", "RPC smoke did not select multipart");
    expect(created.storageTier === "r2", "RPC smoke did not select R2");

    const totalParts = Math.ceil(size / partSize);
    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      const start = (partNumber - 1) * partSize;
      const length = Math.min(partSize, size - start);
      value(
        await files.uploads.uploadPart(created.id, partNumber, fixtureStream(start, length), {
          generation: created.attemptGeneration,
          size: length,
        }),
        `upload part ${partNumber}`,
      );
    }

    const completeKey = `rpc-smoke-complete-${nonce}`;
    const completedResult = await files.uploads.complete(created.id, created.attemptGeneration, {
      idempotencyKey: completeKey,
    });
    const completed = value(completedResult, "complete multipart session");
    expect(completed.hash === expectedHash && completed.size === size, "completion bytes changed");
    liveVersion = completed.version;
    cleanupSessions.shift();

    const replayResult = await files.uploads.complete(created.id, created.attemptGeneration, {
      idempotencyKey: completeKey,
    });
    const replay = value(replayResult, "replay completion");
    expect(replayResult.ok && replayResult.replayed === true, "completion replay was not marked");
    expect(replay.version === completed.version, "completion replay changed the version");

    const raw = await files.raw.get(path);
    expect(raw.ok && "value" in raw, "full raw read failed");
    const full = await streamedHash(raw.value.body);
    expect(full.hash === expectedHash && full.size === size, "full raw bytes changed");

    const rangeStart = 17;
    const rangeEnd = 64;
    const range = await files.raw.get(path, { range: `bytes=${rangeStart}-${rangeEnd}` });
    expect(range.ok && "value" in range, "raw range read failed");
    const rangeBytes = await range.value.bytes(rangeEnd - rangeStart + 1);
    expect(
      rangeBytes.every(
        (byte, index) => byte === fixtureBytes(rangeStart, rangeBytes.length)[index],
      ),
      "raw range bytes changed",
    );

    const successor = value(
      await files.put(
        path,
        { body: "rpc smoke text successor\n", expectedVersion: completed.version },
        { idempotencyKey: `rpc-smoke-text-${nonce}` },
      ),
      "write text successor",
    );
    const rollback = value(
      await files.rollback(
        path,
        { toVersion: completed.version, expectedVersion: successor.version },
        { idempotencyKey: `rpc-smoke-rollback-${nonce}` },
      ),
      "rollback binary version",
    );
    expect(rollback.rollbackOf === completed.version, "rollback target changed");
    liveVersion = rollback.version;

    const history = value(await files.history(path), "read history");
    expect(
      history.versions.filter((version) => version.version === completed.version).length === 1,
      "history does not contain exactly one source version",
    );
    const rolledBackRange = await files.raw.get(path, {
      range: `bytes=${rangeStart}-${rangeEnd}`,
    });
    expect(rolledBackRange.ok && "value" in rolledBackRange, "rolled-back range read failed");
    const rolledBackBytes = await rolledBackRange.value.bytes(rangeEnd - rangeStart + 1);
    expect(
      rolledBackBytes.every(
        (byte, index) => byte === fixtureBytes(rangeStart, rolledBackBytes.length)[index],
      ),
      "rolled-back bytes changed",
    );

    const abandoned = value(
      await files.uploads.create(abandonedPath, {
        expectedVersion: null,
        size: partSize + 1,
        representation: "binary",
        contentType: "application/octet-stream",
        mode: "multipart",
        resumable: true,
        idempotencyKey: `rpc-smoke-create-abort-${nonce}`,
      }),
      "create abort session",
    );
    const abandonedCleanup = {
      id: abandoned.id,
      generation: abandoned.attemptGeneration,
      key: `rpc-smoke-abort-fixture-${nonce}`,
    };
    cleanupSessions.push(abandonedCleanup);
    value(
      await files.uploads.uploadPart(abandoned.id, 1, fixtureStream(0, partSize), {
        generation: abandoned.attemptGeneration,
        size: partSize,
      }),
      "upload abort fixture part",
    );
    value(
      await files.uploads.abort(abandoned.id, abandoned.attemptGeneration, {
        idempotencyKey: abandonedCleanup.key,
      }),
      "abort multipart session",
    );
    const abandonedStatus = value(await files.uploads.status(abandoned.id), "read aborted session");
    expect(abandonedStatus.state === "aborted", "aborted session is not terminal");
    cleanupSessions.pop();

    value(
      await files.delete(
        path,
        { expectedVersion: liveVersion },
        { idempotencyKey: `rpc-smoke-delete-${nonce}` },
      ),
      "final logical delete",
    );
    liveVersion = null;
    const deleted = await files.get(path);
    expect(
      !deleted.ok && deleted.error.code === "file-deleted",
      "final logical delete did not return file-deleted",
    );
    expect(requestStreamCalls > 0, "RPC stream bridge was not exercised");
    expect(byteRouteFallbacks === 0, "a byte route fell back to serialized RPC values");
  } catch (error) {
    smokeFailure = error;
  } finally {
    cleanupFailures = await cleanupRpcSmokeResources(
      cleanupSessions,
      (session) => confirmRpcSmokeSessionTerminal(files.uploads, session),
      async () => {
        const current = await files.get(path);
        if (current.ok && "value" in current) {
          const deleted = await files.delete(
            path,
            { expectedVersion: current.value.version },
            { idempotencyKey: `rpc-smoke-finally-${nonce}` },
          );
          if (!deleted.ok) throw new Error("RPC smoke path cleanup failed");
        } else if (
          !current.ok &&
          current.error.code !== "not-found" &&
          current.error.code !== "file-deleted"
        ) {
          throw new Error("RPC smoke path cleanup could not read the current head");
        }
      },
    );
  }

  if (smokeFailure !== null && cleanupFailures.length > 0) {
    throw new AggregateError(
      [smokeFailure, ...cleanupFailures],
      "RPC multipart smoke failed and cleanup was incomplete",
    );
  }
  if (smokeFailure !== null) throw smokeFailure;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "RPC multipart smoke cleanup was incomplete");
  }
  return {
    ok: true,
    checks: [
      "named-rpc-request-stream",
      "multipart-r2",
      "completion-replay",
      "exact-hash-size",
      "raw-range",
      "rollback-history",
      "abort-cleanup",
      "logical-delete",
    ],
  };
}
