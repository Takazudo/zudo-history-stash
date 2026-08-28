import { createHash, randomUUID } from "node:crypto";

const baseUrl = process.env.MULTIPART_SMOKE_BASE_URL?.replace(/\/$/, "");
const token = process.env.MULTIPART_SMOKE_TOKEN;
const stash = process.env.MULTIPART_SMOKE_STASH;

if (!baseUrl || !token || !stash) {
  throw new Error("Set MULTIPART_SMOKE_BASE_URL, MULTIPART_SMOKE_TOKEN, and MULTIPART_SMOKE_STASH");
}

const authorization = { Authorization: `Bearer ${token}` };
const capabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`);
if (!capabilitiesResponse.ok)
  throw new Error(`Capabilities failed: ${capabilitiesResponse.status}`);
const capabilities = await capabilitiesResponse.json();
const partSize = capabilities.limits?.multipartPartBytes;
if (!Number.isSafeInteger(partSize) || partSize < 1) throw new Error("Invalid multipart part size");

const first = new Uint8Array(partSize);
for (let index = 0; index < first.length; index += 1) first[index] = index % 251;
const final = new TextEncoder().encode("multipart-smoke");
const hash = createHash("sha256").update(first).update(final).digest("hex");
const path = `multipart-smoke/${Date.now()}-${randomUUID()}.bin`;
const idempotency = randomUUID();

const createResponse = await fetch(
  `${baseUrl}/v1/stashes/${encodeURIComponent(stash)}/uploads/${path}`,
  {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `create-${idempotency}`,
    },
    body: JSON.stringify({
      expectedVersion: null,
      size: first.byteLength + final.byteLength,
      hash: `sha256-${hash}`,
      representation: "binary",
      contentType: "application/octet-stream",
      mode: "multipart",
      resumable: true,
    }),
  },
);
if (!createResponse.ok) throw new Error(`Create failed: ${createResponse.status}`);
const session = await createResponse.json();

async function abort() {
  await fetch(`${baseUrl}/v1/stashes/${encodeURIComponent(stash)}/uploads/${session.id}`, {
    method: "DELETE",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
      "Idempotency-Key": `abort-${idempotency}`,
    },
    body: JSON.stringify({ generation: session.attemptGeneration }),
  }).catch(() => undefined);
}

try {
  for (const [index, bytes] of [first, final].entries()) {
    const response = await fetch(
      `${baseUrl}/v1/stashes/${encodeURIComponent(stash)}/uploads/${session.id}/parts/${index + 1}?generation=${session.attemptGeneration}`,
      { method: "PUT", headers: authorization, body: bytes },
    );
    if (!response.ok) throw new Error(`Part ${index + 1} failed: ${response.status}`);
  }
  const completeResponse = await fetch(
    `${baseUrl}/v1/stashes/${encodeURIComponent(stash)}/uploads/${session.id}/complete`,
    {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": `complete-${idempotency}`,
      },
      body: JSON.stringify({ generation: session.attemptGeneration }),
    },
  );
  if (!completeResponse.ok) throw new Error(`Complete failed: ${completeResponse.status}`);
  const rawResponse = await fetch(
    `${baseUrl}/v1/stashes/${encodeURIComponent(stash)}/raw/${path}`,
    { headers: authorization },
  );
  if (!rawResponse.ok) throw new Error(`Raw verification failed: ${rawResponse.status}`);
  const actual = createHash("sha256")
    .update(new Uint8Array(await rawResponse.arrayBuffer()))
    .digest("hex");
  if (actual !== hash) throw new Error("Raw verification hash mismatch");
  process.stdout.write(
    `${JSON.stringify({ path, sessionId: session.id, hash: `sha256-${hash}` })}\n`,
  );
} catch (error) {
  await abort();
  throw error;
}
