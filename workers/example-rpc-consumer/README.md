# RPC consumer example

This private Worker demonstrates a consumer of the History Stash named `StashRpc` entrypoint.
`GET /demo` reads `example-rpc-demo/demo.txt`, writes a demo revision, reads its history, and
rolls back through the typed RPC transport. It is intended as a deployment and integration
example, not a public API.

`GET /binary-demo` uploads arbitrary bytes and streams them back through the flow-controlled
`Request`/`Response` RPC bridge. The bytes never become a serialized/base64 RPC value.

`STASH_TOKEN` is deliberately an empty placeholder in `wrangler.toml` so the binding shape is
visible. In a real deployment, replace it with a Worker secret:

```sh
pnpm exec wrangler secret put STASH_TOKEN
```

After setting the secret, remove `STASH_TOKEN = ""` from `[vars]`; keeping a plaintext value in
the configuration would expose the credential. Give the token write access to the
`example-rpc-demo` stash, or adjust the constants in `src/index.ts` for a different stash.

The `STASH` fetch binding remains available for existing HTTP consumers. This example calls
`STASH_RPC` instead, so the client keeps its normal result unions without HTTP serialisation.
