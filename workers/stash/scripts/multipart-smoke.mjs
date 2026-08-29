import { createHash, randomUUID } from "node:crypto";

const baseUrl = process.env.MULTIPART_SMOKE_BASE_URL?.replace(/\/$/u, "");
const token = process.env.MULTIPART_SMOKE_TOKEN;
const stash = process.env.MULTIPART_SMOKE_STASH;
const rpcUrl = process.env.MULTIPART_SMOKE_RPC_URL?.replace(/\/$/u, "");
const rpcToken = process.env.MULTIPART_SMOKE_RPC_TOKEN;

if (!baseUrl || !token || !stash || !rpcUrl || !rpcToken) {
  throw new Error(
    "Set MULTIPART_SMOKE_BASE_URL, MULTIPART_SMOKE_TOKEN, MULTIPART_SMOKE_STASH, MULTIPART_SMOKE_RPC_URL, and MULTIPART_SMOKE_RPC_TOKEN",
  );
}

const authorization = { Authorization: `Bearer ${token}` };
const prefix = `${baseUrl}/v1/stashes/${encodeURIComponent(stash)}`;
const TERMINAL_UPLOAD_STATES = new Set(["committed", "aborted", "expired", "stale", "failed"]);
// Twenty inter-attempt waits total 35.75s, covering the Worker's 30s part/finalization lease.
const CLEANUP_ATTEMPTS = 21;
const capabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`);
if (!capabilitiesResponse.ok) {
  throw new Error(`Capabilities failed: ${capabilitiesResponse.status}`);
}
const capabilities = await capabilitiesResponse.json();
const partSize = capabilities.limits?.multipartPartBytes;
if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 16 * 1024 * 1024) {
  throw new Error("Refusing a multipart smoke fixture outside the 1..16 MiB safe range");
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(response, operation) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${operation} returned non-JSON (${response.status})`);
  }
  if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
  return value;
}

async function expectStatus(response, operation, status) {
  expect(response.status === status, `${operation} expected ${status}, got ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned non-JSON (${response.status})`);
  }
}

function digest(first, final) {
  return `sha256-${createHash("sha256").update(first).update(final).digest("hex")}`;
}

function pathFor(suffix) {
  return `multipart-smoke/${Date.now()}-${randomUUID()}-${suffix}.bin`;
}

async function deleteFile(path, expectedVersion, key) {
  const response = await fetch(`${prefix}/delete/${path}`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ expectedVersion }),
  });
  return expectStatus(response, "cleanup delete", 200);
}

async function cleanupLivePath(path, key) {
  const response = await fetch(`${prefix}/files/${path}`, { headers: authorization });
  if (response.status === 404) return;
  const current = await json(response, "cleanup current head");
  expect(Number.isSafeInteger(current.version), "cleanup head did not return a version");
  await deleteFile(path, current.version, key);
}

function cleanupDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2_000)));
}

async function uploadSessionState(sessionId) {
  const response = await fetch(`${prefix}/uploads/${sessionId}`, { headers: authorization });
  const status = await json(response, "read cleanup upload session");
  expect(typeof status.state === "string", "cleanup upload session did not return a state");
  return status.state;
}

async function abortSession(session) {
  if (session === null) return;
  let failure = null;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${prefix}/uploads/${session.id}`, {
        method: "DELETE",
        headers: {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": session.abortKey,
        },
        body: JSON.stringify({ generation: session.attemptGeneration }),
      });
      if (response.ok) return;
      failure = new Error(`cleanup abort failed: ${response.status}`);
      if (response.status === 409 || response.status === 410) {
        const state = await uploadSessionState(session.id);
        if (TERMINAL_UPLOAD_STATES.has(state)) return;
        failure = new Error(`cleanup upload session remained ${state}`);
      } else if (response.status < 500) {
        break;
      }
    } catch (error) {
      failure = error;
    }
    if (attempt + 1 < CLEANUP_ATTEMPTS) await cleanupDelay(attempt);
  }
  throw failure ?? new Error("cleanup abort failed");
}

const first = new Uint8Array(partSize);
for (let index = 0; index < first.length; index += 1) first[index] = index % 251;
const final = new TextEncoder().encode("multipart-smoke".slice(0, Math.min(partSize, 15)));
const expectedSize = first.byteLength + final.byteLength;
const expectedHash = digest(first, final);
const path = pathFor("committed");
const abandonedPath = pathFor("aborted");
const nonce = randomUUID();
let committedVersion = null;
let committedSession = null;
let abandonedSession = null;
let smokeFailure = null;
const cleanupFailures = [];

try {
  const createResponse = await fetch(`${prefix}/uploads/${path}`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `create-${nonce}`,
    },
    body: JSON.stringify({
      expectedVersion: null,
      size: expectedSize,
      hash: expectedHash,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "multipart",
      resumable: true,
    }),
  });
  const session = await json(createResponse, "create multipart session");
  committedSession = { ...session, abortKey: `abort-${nonce}` };
  expect(session.mode === "multipart", "server did not select multipart mode");
  expect(session.storageTier === "r2", "multipart session did not select R2 staging");

  for (const [index, bytes] of [first, final].entries()) {
    const response = await fetch(
      `${prefix}/uploads/${session.id}/parts/${index + 1}?generation=${session.attemptGeneration}`,
      {
        method: "PUT",
        headers: authorization,
        body: bytes,
      },
    );
    expect(response.ok, `part ${index + 1} failed: ${response.status}`);
  }

  const completeKey = `complete-${nonce}`;
  const completeBody = { generation: session.attemptGeneration };
  const completeResponse = await fetch(`${prefix}/uploads/${session.id}/complete`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": completeKey,
    },
    body: JSON.stringify(completeBody),
  });
  const completion = await json(completeResponse, "complete multipart session");
  committedVersion = completion.version;
  expect(Number.isSafeInteger(committedVersion), "completion did not return a version");
  committedSession = null;

  const replayResponse = await fetch(`${prefix}/uploads/${session.id}/complete`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": completeKey,
    },
    body: JSON.stringify(completeBody),
  });
  const replay = await json(replayResponse, "replay multipart completion");
  expect(
    replayResponse.headers.get("Idempotent-Replayed") === "true",
    "completion replay was not marked",
  );
  expect(replay.version === committedVersion, "completion replay changed the version");

  const fileResponse = await fetch(`${prefix}/files/${path}`, { headers: authorization });
  const file = await json(fileResponse, "read binary metadata");
  expect(file.version === committedVersion, "binary metadata version mismatch");
  expect(file.representation === "binary", "binary metadata representation changed");
  expect(
    file.contentAccess === "raw" && file.body === null,
    "binary metadata was unexpectedly inline",
  );

  const rawResponse = await fetch(`${prefix}/raw/${path}`, { headers: authorization });
  expect(rawResponse.ok, `raw read failed: ${rawResponse.status}`);
  expect(rawResponse.headers.get("Content-Length") === String(expectedSize), "raw size mismatch");
  const rawBytes = new Uint8Array(await rawResponse.arrayBuffer());
  expect(
    digest(rawBytes.slice(0, first.length), rawBytes.slice(first.length)) === expectedHash,
    "raw hash mismatch",
  );

  const headResponse = await fetch(`${prefix}/raw/${path}`, {
    method: "HEAD",
    headers: authorization,
  });
  expect(headResponse.status === 200, `raw HEAD failed: ${headResponse.status}`);
  expect(headResponse.body === null, "raw HEAD returned a body");
  expect(
    headResponse.headers.get("Content-Length") === String(expectedSize),
    "raw HEAD size mismatch",
  );

  const rangeStart = Math.min(17, first.length - 1);
  const rangeEnd = Math.min(rangeStart + 47, first.length - 1);
  const rangeResponse = await fetch(`${prefix}/raw/${path}`, {
    headers: { ...authorization, Range: `bytes=${rangeStart}-${rangeEnd}` },
  });
  expect(rangeResponse.status === 206, `raw range failed: ${rangeResponse.status}`);
  expect(
    rangeResponse.headers.get("Content-Range") ===
      `bytes ${rangeStart}-${rangeEnd}/${expectedSize}`,
    "raw range metadata mismatch",
  );
  const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
  expect(
    rangeBytes.every((byte, index) => byte === first[rangeStart + index]),
    "raw range bytes mismatch",
  );

  const rawEtag = rawResponse.headers.get("ETag");
  expect(rawEtag !== null, "raw response did not return an ETag");
  const conditional = await fetch(`${prefix}/raw/${path}`, {
    headers: { ...authorization, "If-None-Match": rawEtag },
  });
  expect(conditional.status === 304, `raw conditional read failed: ${conditional.status}`);

  const textSuccessor = await fetch(`${prefix}/files/${path}`, {
    method: "PUT",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `text-${nonce}`,
    },
    body: JSON.stringify({ body: "text successor\n", expectedVersion: committedVersion }),
  });
  const successor = await json(textSuccessor, "write text successor");
  committedVersion = successor.version;
  const rollbackKey = `rollback-${nonce}`;
  const rollbackResponse = await fetch(`${prefix}/rollback/${path}`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": rollbackKey,
    },
    body: JSON.stringify({ toVersion: completion.version, expectedVersion: successor.version }),
  });
  const rollback = await json(rollbackResponse, "rollback binary version");
  committedVersion = rollback.version;
  expect(rollback.rollbackOf === completion.version, "rollback target mismatch");
  const rolledBack = await fetch(`${prefix}/raw/${path}`, { headers: authorization });
  expect(rolledBack.ok, `rolled-back raw read failed: ${rolledBack.status}`);
  const rolledBackBytes = new Uint8Array(await rolledBack.arrayBuffer());
  expect(
    digest(rolledBackBytes.slice(0, first.length), rolledBackBytes.slice(first.length)) ===
      expectedHash,
    "rollback bytes mismatch",
  );

  const historyResponse = await fetch(`${prefix}/history/${path}`, { headers: authorization });
  const history = await json(historyResponse, "read multipart history");
  expect(
    history.versions.some(
      (version) => version.version === completion.version && version.hash === expectedHash,
    ),
    "history omitted binary version",
  );

  const deleted = await deleteFile(path, committedVersion, `delete-${nonce}`);
  const deletedVersion = deleted.version;
  committedVersion = deletedVersion;
  const deletedRead = await fetch(`${prefix}/files/${path}`, { headers: authorization });
  expect(
    deletedRead.status === 404,
    `deleted head read unexpectedly returned ${deletedRead.status}`,
  );

  const resurrectedResponse = await fetch(`${prefix}/files/${path}`, {
    method: "PUT",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `resurrect-${nonce}`,
    },
    body: JSON.stringify({ body: "resurrected\n", expectedVersion: deletedVersion }),
  });
  const resurrected = await json(resurrectedResponse, "resurrect file");
  expect(resurrected.version > deletedVersion, "resurrection did not append a version");
  committedVersion = resurrected.version;
  await deleteFile(path, resurrected.version, `cleanup-${nonce}`);
  committedVersion = null;

  const abortCreateResponse = await fetch(`${prefix}/uploads/${abandonedPath}`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `create-abort-${nonce}`,
    },
    body: JSON.stringify({
      expectedVersion: null,
      size: partSize + 1,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "multipart",
      resumable: true,
    }),
  });
  const abortCandidate = await json(abortCreateResponse, "create abort fixture");
  abandonedSession = { ...abortCandidate, abortKey: `abort-fixture-${nonce}` };
  await abortSession(abandonedSession);
  const abortedStatusResponse = await fetch(`${prefix}/uploads/${abandonedSession.id}`, {
    headers: authorization,
  });
  const abortedStatus = await json(abortedStatusResponse, "read aborted session");
  expect(abortedStatus.state === "aborted", "aborted multipart session is not terminal");
  abandonedSession = null;
} catch (error) {
  smokeFailure = error;
} finally {
  let sessionsTerminal = true;
  for (const session of [abandonedSession, committedSession]) {
    try {
      await abortSession(session);
    } catch (error) {
      sessionsTerminal = false;
      cleanupFailures.push(error);
    }
  }
  // A committed version remains in immutable history by design; the final tombstone removes the
  // live path. Generation-aware GC can reclaim only unreferenced staging/orphan objects later.
  if (sessionsTerminal) {
    try {
      await cleanupLivePath(path, `finally-${nonce}`);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
}

if (smokeFailure !== null && cleanupFailures.length > 0) {
  throw new AggregateError(
    [smokeFailure, ...cleanupFailures],
    "Multipart smoke failed and cleanup was incomplete",
  );
}
if (smokeFailure !== null) throw smokeFailure;
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, "Multipart smoke cleanup was incomplete");
}

const rpcResponse = await fetch(`${rpcUrl}/multipart-smoke`, {
  method: "POST",
  headers: { Authorization: `Bearer ${rpcToken}` },
});
const rpcProof = await json(rpcResponse, "named-RPC multipart probe");
const requiredRpcChecks = [
  "named-rpc-request-stream",
  "multipart-r2",
  "completion-replay",
  "exact-hash-size",
  "raw-range",
  "rollback-history",
  "abort-cleanup",
  "logical-delete",
];
expect(rpcProof.ok === true, "named-RPC multipart probe did not succeed");
expect(Array.isArray(rpcProof.checks), "named-RPC multipart probe did not return checks");
expect(
  requiredRpcChecks.every((check) => rpcProof.checks.includes(check)),
  "named-RPC multipart probe omitted a required check",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    checks: [
      "multipart",
      "completion-replay",
      "range",
      "head",
      "conditional",
      "rollback",
      "history",
      "delete-resurrection",
      "abort-cleanup",
      "named-rpc-multipart",
    ],
    cleanup: "logical-delete",
  })}\n`,
);
