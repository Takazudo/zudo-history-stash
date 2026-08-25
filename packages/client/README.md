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
