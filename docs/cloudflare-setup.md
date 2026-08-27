# Cloudflare setup

The Workers are created by `wrangler deploy` from this repository. Do not create a competing dashboard Worker or Git-connected build pipeline. Keep binding IDs and public config in the committed `wrangler.toml`; keep tokens and Worker secrets out of git.

## CI API token

Create a scoped Cloudflare API token with these permissions:

| Scope   | Permission                 |
| ------- | -------------------------- |
| Account | Workers Scripts — Edit     |
| Account | Account Settings — Read    |
| Account | D1 — Edit                  |
| Account | Workers R2 Storage — Write |
| Zone    | Workers Routes — Edit      |

The Zone permission needs the actual zone in the token's Zone Resources selection when routes are used. Set the CI credentials with:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

The deploy workflows deliberately self-skip with a green check while either secret is absent. Once the account is provisioned, set optional repository variables `STASH_SMOKE_BASE_URL` and `VIEWER_SMOKE_BASE_URL` to enable the post-deploy smoke URLs.

## D1 provisioning

Create the production and preview databases, decline Wrangler's offer to edit the config automatically, and paste the printed IDs into the committed `workers/stash/wrangler.toml` bindings:

```bash
pnpm exec wrangler d1 create zudo-history-stash
pnpm exec wrangler d1 create zudo-history-stash-preview
```

The deployment remains skipped until the Cloudflare credentials and committed D1 IDs are ready. Apply migrations from `workers/stash` with `pnpm exec wrangler d1 migrations apply zudo-history-stash --remote` before deploying code.

## R2 provisioning

Create separate production and preview buckets. Their names already match the committed `BLOBS`
bindings in `workers/stash/wrangler.toml`:

```bash
pnpm exec wrangler r2 bucket create zudo-history-stash-blobs
pnpm exec wrangler r2 bucket create zudo-history-stash-blobs-preview
```

Keep both buckets private. Do not enable an `r2.dev` URL or attach a custom domain; the stash
Worker accesses objects only through its R2 binding.

Spilled blob rows created before the R2 generation rollout continue to read their exact legacy
keys (`<stash>/sha256-<64 lowercase hex>`). New uploads write only generation-scoped keys
(`v2/<stash>/<sha256-hash>/<lowercase UUID>`). Each upload attempt gets a fresh generation, so a
concurrent or retried write cannot overwrite another attempt's object. Deploy the new Worker before
introducing any lifecycle or garbage-collection process that interprets these formats; no data
migration is required for legacy reads.

## Rate-limiting namespaces

The stash Worker uses Cloudflare Rate Limiting bindings for three capability buckets. Namespace IDs
are account-wide: bindings with the same ID share counters, even across Workers. Keep production and
preview on the committed, disjoint allocation below.

| Binding    | Capability | Limit per location | Production namespace | Preview namespace |
| ---------- | ---------- | ------------------ | -------------------- | ----------------- |
| `RL_READ`  | Reads      | 600 per 60 seconds | `1101`               | `1201`            |
| `RL_WRITE` | Writes     | 60 per 60 seconds  | `1102`               | `1202`            |
| `RL_DIFF`  | Diffs      | 120 per 60 seconds | `1103`               | `1203`            |

The platform counters are per Cloudflare location, permissive, and eventually consistent. The API
therefore guarantees only that a limiter result of `{ success: false }` produces a `429` response
with `Retry-After: 60`; it does not promise an exact global cutoff. Administrator requests bypass
the bindings, and a binding exception fails open with a structured warning so a limiter outage does
not take the stash API down.

## Worker secret and viewer access

Set the admin credential locally or remotely; the value is never committed:

```bash
pnpm exec wrangler secret put STASH_ADMIN_TOKEN
```

For local development, put the corresponding value in `workers/stash/.dev.vars` (copy the example file). Put Cloudflare Access in front of the viewer hostname when it is exposed to operators; the viewer itself holds no stash secret and only receives the token pasted into its login screen. Configure `previews_enabled` for each preview Worker when preview URLs are enabled, and keep preview service bindings pointed at `zudo-history-stash-preview`.

See [README.md](../README.md) for local commands and [the Cloudflare deploy-from-zero guidance](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/main/src/content/docs/workers/deploy-from-zero.mdx) for provisioning pitfalls.
