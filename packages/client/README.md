# @takazudo/zudo-history-stash

Typed, isomorphic HTTP client for the zudo-history-stash API. It runs in Node.js, browsers, and
Cloudflare Workers and returns typed business outcomes for API validation and conflict responses.

```bash
pnpm add @takazudo/zudo-history-stash
```

```ts
import { createStashClient } from "@takazudo/zudo-history-stash";

const client = createStashClient({
  baseUrl: "https://stash.example.com",
  token: "zhs_…",
  clientId: "viewer-tab-7",
});

const file = await client.files("docs").get("README.md");
if (file.ok && "value" in file) {
  console.log(file.value.body, file.value.etag);
}
```

For a same-account Worker, the recommended transport is a named `StashRpc` entrypoint. Type its
binding as `StashRpcEntrypoint` and use the discriminated `transport` option:

```ts
import { createStashClient, type StashRpcEntrypoint } from "@takazudo/zudo-history-stash";

interface Env {
  STASH_RPC: StashRpcEntrypoint;
  STASH_TOKEN: string;
}

const client = createStashClient({
  transport: { kind: "rpc", binding: env.STASH_RPC, token: env.STASH_TOKEN },
});
```

The RPC transport uses its token per call. Business responses remain the same discriminated result
unions as fetch (`{ ok: false, error, current? }`); a rejected binding call throws
`StashHttpError` with `status === 0`. Direct `StashRpcEntrypoint` methods instead accept the token
as their first argument. After dispatch, they return serialisable `Result` unions for business
failures and internal exceptions, but callers should still catch an outer binding rejection before
dispatch or during platform serialisation.

The existing fetch transport remains compatible. For a same-account Worker service binding, the
hostname is inert and the binding supplies fetch:

```ts
const client = createStashClient({
  baseUrl: "https://stash.internal",
  token,
  fetch: (input, init) => env.STASH.fetch(input, init),
});
```

`files.put`, `files.delete`, and `files.rollback` mint an `Idempotency-Key` by default. Pass
`{ idempotencyKey: "…" }` to make a retry use a stable key. A replayed response has
`replayed: true`; a representation cache hit is `{ ok: true, notModified: true }`.

## Binary and large objects

`client.capabilities()` returns the server's current transfer and file-size limits. The high-level
`files(stash).upload(path, source, options)` API accepts `Blob`, `ArrayBuffer`, typed-array/DataView
views, byte `ReadableStream`, and strings. Representation is always explicit; transfer mode, MIME
type, and size never change `text` into `binary` or the reverse.

```ts
const files = client.files("assets");
const uploaded = await files.upload("icons/logo.png", pngBlob, {
  expectedVersion: null,
  representation: "binary",
  contentType: "image/png",
  resumable: true,
  onProgress: ({ observedBytes, durableParts }) => {
    // observedBytes are source bytes consumed; durableParts are server-recorded parts.
  },
});

const download = await files.raw.get("icons/logo.png", { range: "bytes=0-1023" });
if (download.ok && "value" in download) {
  const bytes = await download.value.bytes(1024); // explicit materialization bound
  // download.value.body is the unbuffered ReadableStream for larger consumers.
}
```

Mode selection is capability-driven: eligible replayable small text uses legacy JSON, a source at
or below `singleUploadMaxBytes` uses one raw request, and larger or explicitly resumable sources use
multipart. An explicit `mode` is checked against current capabilities. Binary is never base64
encoded. Large valid UTF-8 stays `text` but uses raw content access.

The published Worker defaults are `jsonInlineMaxBytes=5000000`, `d1InlineMaxBytes=524288`,
`httpRequestMaxBytes=100000000`, `singleUploadMaxBytes=33554432`, `maxFileBytes=100000000`,
`diffMaxBytesPerSide=524288`, `multipartPartBytes=8388608`,
`maxOpenUploadSessionsPerStash=8`, `maxReservedUploadBytesPerStash=500000000`, and
`uploadSessionTtlSeconds=86400`; `maxMultipartParts` is always 10,000. The server may override
these values, so clients must use `capabilities()` and exact content-byte accounting. D1 inline is
capped at 1,500,000 bytes and `maxFileBytes` at 1,073,741,824 bytes (1 GiB), with reservation
capacity at least as large as the file ceiling and no more than 10,000 multipart parts. One GiB is
a correctness ceiling, not a performance certification; tests inject small thresholds and do not
allocate a 1 GiB source.

These limits do not collapse the independent axes: representation (`text | binary`), content
access (`inline | raw | deleted`), transfer (`json | single | multipart`), storage (`d1 | r2`),
and diff eligibility are separate. A valid UTF-8 text source remains text above 5 MB, while a small
binary source may be D1-inline.

A `ReadableStream` is caller-owned and one-shot. Supply its exact `size`; cancellation is forwarded
to Fetch/RPC where supported, and the client never automatically replays a consumed stream.
Blob/buffer sources are replayable and may use `retries`; keep mutable ArrayBuffers/views unchanged
until the operation settles. Multipart retries only the current failed part.
Use `files.uploads` to create, inspect, resume, abort, upload/replace individual parts, or idempotently
complete a durable session yourself. Progress reports bytes observed while consuming known sources
and durable multipart part counts—it does not claim browser network acknowledgement.

Raw current and historical downloads use `files.raw.get(path, { version? })`; `head` provides the
same validator/version metadata without a body. Convenience `bytes(maxBytes)` and
`text(maxBytes)` methods deliberately require a bound and cancel reads that exceed it.

Write tokens are full-stash credentials and should not be embedded in browser code. Use a read
token for browser-direct consumers.

`clientId` is an optional stable mutation origin used to suppress a caller's own live-update
echoes. It must be 1–64 printable ASCII characters with no leading or trailing whitespace; values
matching `^[!-~](?:[ -~]{0,62}[!-~])?$` round-trip unchanged through Fetch headers. The SDK sends
`X-Stash-Client-Id` on non-GET, non-read-principal mutation operations over both fetch and generic
RPC transports, and never sends it on reads.

## In-memory testing fake

The `./testing` subpath provides a deliberately narrow, environment-neutral fetch fake. It is for
consumer tests that exercise file operations without booting workerd; it is not a replacement for
the real Worker or its D1 tests.

```ts
import { createStashClient } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";

const fake = createFakeStash({ adminToken: "test-admin" });
fake.createStash("docs");
const token = await fake.mintToken("docs", "write");

const client = createStashClient({
  baseUrl: "https://stash.test",
  token,
  fetch: fake.fetch,
});
```

`fake.state` exposes the in-memory stash, token, blob, file, version, upload-session, and idempotency tables for
direct fixture setup and assertions. `fake.reset()` clears those tables without replacing the
state object. Pass `now` to control timestamps and token expiry; pass `rateLimit` to inject
Cloudflare-shaped capability/key verdicts (rejections fail open, matching the Worker).

The fake implements the SDK route surface, including exact binary bytes, upload sessions, raw ranges, and the authenticated fetch-only
stash event stream, except for health, import, and cross-stash changes. Those unsupported routes
and unknown routes return `501 not-implemented`.
`await fake.mintToken()` remains available for direct fixture setup, accepts `expiresAt` or
`ttlSeconds`, and uses the same hash-only storage path as the token-management routes.

Live tests can drive the stable `fake.events` controller directly:

```ts
const stream = client.files("docs").events();
const iterator = stream[Symbol.asyncIterator]();
await iterator.next(); // authoritative ready event

fake.events.emit({
  type: "change-set",
  changeSetId: "cst_1787875200000deadbeef",
  stash: "docs",
  paths: ["README.md"],
  status: "open",
  origin: null,
});
const changeSet = await iterator.next();

fake.events.rotate("docs", "lifetime");
stream.close();
```

The controller also provides `close`, `error`, and `subscriberCount` for lifecycle assertions.

The same exported conformance runner is used to detect drift between the fake and the real Worker:

```ts
import { runConformance } from "@takazudo/zudo-history-stash/testing";

await runConformance(targetFetch, targetBaseUrl, {
  adminToken,
  advanceTime,
  configureRateLimit,
});
```

`advanceTime(milliseconds)` crosses the trace's expiry boundary; `configureRateLimit(target)`
arranges a denial for the supplied capability and `p:<tokenId>` key. The fake test adapter can move
an injected clock and update a verdict set synchronously. For a running local Worker, use the
checked-in `packages/client/scripts/conformance-live.mjs` runner documented in the repository's
`TESTING.md`; it sleeps for the real clock and safely exhausts the local write bucket.
