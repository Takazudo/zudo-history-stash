# Cloudflare setup

The Workers are created by `wrangler deploy` from this repository. Do not create a competing dashboard Worker or Git-connected build pipeline. Keep binding IDs and public config in the committed `wrangler.toml`; keep tokens and Worker secrets out of git.

## CI API token

Create a scoped Cloudflare API token with these permissions:

| Scope   | Permission              |
| ------- | ----------------------- |
| Account | Workers Scripts — Edit  |
| Account | Account Settings — Read |
| Account | D1 — Edit               |
| Zone    | Workers Routes — Edit   |

The Zone permission needs the actual zone in the token's Zone Resources selection when routes are used. Set the CI credentials with:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

The deploy workflows deliberately self-skip with a green check while either secret is absent. Once the account is provisioned, set optional repository variables `STASH_SMOKE_BASE_URL` and `VIEWER_SMOKE_BASE_URL` to enable the post-deploy smoke URLs.

## D1 provisioning

Create the production and preview databases, decline Wrangler's offer to edit the config automatically, and paste the printed IDs into the committed `workers/stash/wrangler.toml` bindings:

```bash
npx wrangler@4 d1 create zudo-history-stash
npx wrangler@4 d1 create zudo-history-stash-preview
```

The deployment remains skipped until the Cloudflare credentials and committed D1 IDs are ready. Apply migrations from `workers/stash` with `npx wrangler@4 d1 migrations apply zudo-history-stash --remote` before deploying code.

## Worker secret and viewer access

Set the admin credential locally or remotely; the value is never committed:

```bash
npx wrangler@4 secret put STASH_ADMIN_TOKEN
```

For local development, put the corresponding value in `workers/stash/.dev.vars` (copy the example file). Put Cloudflare Access in front of the viewer hostname when it is exposed to operators; the viewer itself holds no stash secret and only receives the token pasted into its login screen. Configure `previews_enabled` for each preview Worker when preview URLs are enabled, and keep preview service bindings pointed at `zudo-history-stash-preview`.

See [README.md](../README.md) for local commands and [the Cloudflare deploy-from-zero guidance](https://github.com/Takazudo/zudo-cloudflare-wisdom/blob/main/src/content/docs/workers/deploy-from-zero.mdx) for provisioning pitfalls.
