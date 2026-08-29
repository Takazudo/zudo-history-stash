# RPC consumer example

This private Worker demonstrates a consumer of the History Stash named `StashRpc` entrypoint.
`GET /demo` reads `example-rpc-demo/demo.txt`, writes a demo revision, reads its history, and
rolls back through the typed RPC transport. It is intended as a deployment and integration
example, not a public API. Every executable route is disabled unless `RPC_SMOKE_TRIGGER_TOKEN` is
configured and requires that value as a bearer token before any Stash call.

`GET /binary-demo` uploads arbitrary bytes and streams them back through the flow-controlled
`Request`/`Response` RPC bridge. The bytes never become a serialized/base64 RPC value.

Keep `STASH_TOKEN` in a Worker secret or an ignored `.dev.vars*` file, never in `wrangler.toml`:

```sh
pnpm exec wrangler secret put STASH_TOKEN
```

Give the token write access to the `example-rpc-demo` stash, or adjust the constants in
`src/index.ts` for a different stash.

The `STASH` fetch binding remains available for existing HTTP consumers. This example calls
`STASH_RPC` instead, so the client keeps its normal result unions without HTTP serialisation.

## Remote multipart smoke

`POST /multipart-smoke`, `GET /demo`, and `GET /binary-demo` are disabled unless
`RPC_SMOKE_TRIGGER_TOKEN` is configured, and each checks that bearer before any Stash call. The
smoke route uses `MULTIPART_SMOKE_STASH` plus the internal
`STASH_TOKEN`; it never accepts a Stash credential from the request. Its response contains only an
`ok` flag and check names—never an upload ID, object key, path, generation, hash, or token.
Failure cleanup waits past the normal 30-second upload lease and requires terminal state for every
tracked session before deleting the live path; an unresolved session fails the probe instead of
racing a late finalizer.

For the opt-in verification in [TESTING.md](../../TESTING.md#opt-in-real-r2-and-named-rpc-multipart-smoke),
copy `.dev.vars.example` to the ignored `.dev.vars.preview`, fill the three values, then run:

```bash
pnpm build:libs
pnpm --filter zudo-history-stash-example-rpc-consumer exec wrangler dev --remote --env preview --port 8791
```

The preview service binding points at the already deployed `zudo-history-stash-preview` named
`StashRpc` entrypoint, so the practical multipart fixture crosses the flow-controlled
`requestStream()` bridge into that Worker's real R2 binding. Use the combined command in
`TESTING.md` from a second shell. Remote development is ephemeral; do not deploy these gated
examples as general public mutation endpoints, and never commit either secret.
