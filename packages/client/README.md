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

For a same-account Worker service binding, the hostname is inert and the binding supplies fetch:

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
const token = fake.mintToken("docs", "write");

const client = createStashClient({
  baseUrl: "https://stash.test",
  token,
  fetch: fake.fetch,
});
```

`fake.state` exposes the in-memory stash, token, blob, file, version, and idempotency tables for
direct fixture setup and assertions. `fake.reset()` clears those tables without replacing the
state object. Pass `now` to freeze timestamps.

The fake implements only `GET /v1/me`, `POST /v1/stashes`, and the stash-scoped file list, file
read/write/delete/rollback, history, changes, and stored/candidate diff routes. All other routes —
including health, stash listing/details, token management, import, and cross-stash changes — return
`501 not-implemented`. Token-management setup therefore uses `fake.mintToken()` directly.

The same exported conformance runner is used to detect drift between the fake and the real Worker:

```ts
import { runConformance } from "@takazudo/zudo-history-stash/testing";

await runConformance(fetch, "http://localhost:8787/api", {
  adminToken: process.env.STASH_ADMIN_TOKEN!,
});
```

Fake-only conformance runs additionally pass `mintToken: fake.mintToken`; real-worker runs mint the
read token through the server's admin endpoint.
