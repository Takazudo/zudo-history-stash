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

Write tokens are full-stash credentials and should not be embedded in browser code. Use a read
token for browser-direct consumers.

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

`fake.state` exposes the in-memory stash, token, blob, file, version, and idempotency tables for
direct fixture setup and assertions. `fake.reset()` clears those tables without replacing the
state object. Pass `now` to freeze timestamps.

The fake implements `GET /v1/me`, stash list/create/detail, token create/list/revoke, and the
stash-scoped file list, file read/write/delete/rollback, history, changes, and stored/candidate diff
routes. Health, import, cross-stash changes, and unknown routes return `501 not-implemented`.
`await fake.mintToken()` remains available for direct fixture setup and uses the same hash-only
storage path as the token-management routes.

The same exported conformance runner is used to detect drift between the fake and the real Worker:

```ts
import { runConformance } from "@takazudo/zudo-history-stash/testing";

await runConformance(fetch, "http://localhost:8787/api", {
  adminToken: process.env.STASH_ADMIN_TOKEN!,
});
```

Fake and real-Worker conformance runs use the same options object; the trace creates, authenticates,
lists, and revokes its read/write tokens through the admin endpoints.
