# Disposable-account verification

The owner has decided to use a disposable Cloudflare account for verification only, keep
`MAX_COMMIT_ENTRIES` at 20, and prove teardown before declaring the run complete. Production
hostnames, the production plan floor, and ongoing spend remain deferred. Every step below is for a
human operator: agents must not perform live Cloudflare mutations.

## Before any credential exists

Complete these steps in order. Stop if either check fails.

1. First, confirm that `scripts/deploy-gate.sh` is merged to `main`, the repository's default
   branch. The three production workflows run trusted code from the default branch, so
   `PRODUCTION_DEPLOY_DISABLED` protects nothing until the gate is present there. Fetch and inspect
   the exact default-branch copy, including its first check for that variable:

   ```bash
   git fetch origin main
   git show origin/main:scripts/deploy-gate.sh
   ```

2. Then, before creating or setting either Cloudflare repository secret, enable the repository
   kill switch:

   ```bash
   gh variable set PRODUCTION_DEPLOY_DISABLED --body 'true'
   ```

   Confirm the variable is present without printing any credential:

   ```bash
   gh variable get PRODUCTION_DEPLOY_DISABLED
   ```

This ordering is mandatory. `.github/workflows/deploy-stash.yml`,
`.github/workflows/deploy-viewer.yml`, and `.github/workflows/doc-deploy.yml` can all run
`wrangler deploy` against production custom domains after a push to `main`. The documentation
workflow's path filter includes `packages/**`, so an ordinary merge could otherwise deploy the
documentation site to the throwaway account. All three call `scripts/deploy-gate.sh`, whose first
check is `PRODUCTION_DEPLOY_DISABLED`.

The preview workflows are deliberately unaffected. `.github/workflows/preview.yml`,
`.github/workflows/preview-teardown.yml`, and `.github/workflows/preview-reaper.yml` route through
`scripts/preview-gate.sh`; these are the workflows being verified.

## Provisioning the throwaway account

1. Create a fresh Cloudflare account used for nothing else. Do not add a production hostname,
   production D1 database, or other long-lived resource.
2. Record whether the account is on the Free or Paid Workers plan. The applicable D1
   queries-per-invocation limit is 50 on Free and 1,000 on Paid, and that value must be supplied to
   the commit-batch probe. See `TESTING.md` under **Recorded remote probe outcome**.
3. Create an API token scoped to this account only. It needs Workers Scripts — Edit/Write, D1 —
   Edit, and Workers R2 Storage — Edit/Write. It must have neither Workers Routes nor Account
   Settings — Read. Use the canonical CI API token permission table in
   `docs/cloudflare-setup.md`, lines 11–17, rather than broadening or restating its scope in an
   external note.
4. Only after `PRODUCTION_DEPLOY_DISABLED` is confirmed as `true`, set the two repository secrets
   through their interactive prompts, then set the non-secret Workers-subdomain label:

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set CLOUDFLARE_ACCOUNT_ID
   gh variable set CF_WORKERS_SUBDOMAIN --body '<account-workers-subdomain>'
   ```

   The subdomain value is the account label only, without `.workers.dev`. Do not put any literal
   credential or account identifier on a command line, in shell history, or in a file.
5. Leave the placeholders in `workers/stash/wrangler.toml:20` and
   `workers/viewer/wrangler.toml:17` unchanged throughout this run. Do not provision production D1
   and do not choose a production hostname on the throwaway account.

## Executing the preview checklist

GitHub issue [#183](https://github.com/Takazudo/zudo-history-stash/issues/183) is the checklist of
record. A human operator must execute it using disposable, same-repository verification PRs only
and tick every box in that issue; do not duplicate the checklist here or use a fork or production
resource as a substitute.

Follow the exact resource-name and evidence conventions in `docs/cloudflare-setup.md`, lines
90–190, and `doc/src/content/docs/guides/pull-request-previews.mdx`. Record only the requested PR
numbers, resource names, verdicts, and workflow-run links. Treat the preview comment's read token
as a credential even though it is scoped to disposable data: never copy it into an issue, commit,
artifact, screenshot, or ordinary log.

## Running the commit-batch probe

After the preview checklist succeeds, use a separate disposable D1 database on the same throwaway
account. Never target a production or PR-preview database.

1. Create the disposable D1 database, then copy the probe template and paste only that database's
   ID into the local copy:

   ```bash
   pnpm exec wrangler d1 create zudo-history-stash-commit-batch-probe
   cp workers/stash/wrangler.probe.local.example.toml workers/stash/wrangler.probe.local.toml
   ```

2. Prove the credential-bearing local config is ignored before continuing:

   ```bash
   git check-ignore workers/stash/wrangler.probe.local.toml
   ```

   Stop if this command does not print the path.
3. Run local mode first as a credential-free smoke check:

   ```bash
   pnpm --filter zudo-history-stash probe:commit-batch
   ```

4. Run remote mode with the plan's exact query limit: use `50` for Free or `1000` for Paid. The
   complete form is also documented in `TESTING.md`, lines 312–317:

   ```bash
   CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
   CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
   COMMIT_BATCH_PROBE_REMOTE=1 \
   COMMIT_BATCH_PROBE_WRANGLER_CONFIG=wrangler.probe.local.toml \
   COMMIT_BATCH_PROBE_QUERY_LIMIT=1000 \
   pnpm --filter zudo-history-stash probe:commit-batch
   ```

   Change only the query-limit value to `50` on Free. Do not echo either environment variable or
   enable shell tracing.
5. Do not run two probes concurrently against the same database: their three
   `commit_batch_live_probe_*` scratch-table names are fixed. An interrupted run can leave those
   tables behind; the next run drops them before starting and again during normal cleanup.
6. Paste the probe's JSON into the **Evidence** cell of the `#### Recorded remote probe outcome`
   table in `TESTING.md`, and transcribe its plan, supplied limit, statement count, result, elapsed
   time, and `limitAssessment` into the row. Inspect it first and redact any credential or account
   identifier if unexpected diagnostic output was captured.

`MAX_COMMIT_ENTRIES` stays 20 regardless of the measurement unless the owner makes a separate
decision. This run makes the cap of 20 verified; it does not authorize changing it.

## Teardown

This is a proof-of-absence gate. Complete the following steps in order, and treat a failure or an
unverified absence at any step as blocking completion. Keep `PRODUCTION_DEPLOY_DISABLED=true`
throughout.

1. Close every verification PR.
2. Tick every final-cleanup box in issue #183. Review failed and cancelled runs for partial state.
3. Verify that every verification PR's exact `-pr-N` stash Worker, Viewer Worker, D1 database, R2
   bucket and objects, and stash-owned `StashEvents` Durable Object namespace are absent. A
   successful delete request alone is not proof; use the authoritative absence checks and workflow
   evidence required by #183.
4. If orphaned PR resources remain, manually dispatch the reaper before closing the account, then
   repeat the absence checks:

   ```bash
   gh workflow run preview-reaper.yml --ref main
   ```

5. Delete the probe's disposable D1 database and verify it is absent from the account.
6. Delete `workers/stash/wrangler.probe.local.toml` from the working tree and confirm it is absent.
7. Delete both repository secrets:

   ```bash
   gh secret delete CLOUDFLARE_API_TOKEN
   gh secret delete CLOUDFLARE_ACCOUNT_ID
   ```

8. Revoke the API token in the Cloudflare dashboard. Deleting the GitHub secret does not revoke
   the token.
9. Delete the Workers-subdomain variable:

   ```bash
   gh variable delete CF_WORKERS_SUBDOMAIN
   ```

10. Close the disposable Cloudflare account and retain non-secret proof that it is closed.
11. Only after the resources and probe database are absent, the local config is gone, both secrets
    are deleted, the API token is revoked, the subdomain variable is deleted, and the account is
    closed, remove the kill switch:

    ```bash
    gh variable delete PRODUCTION_DEPLOY_DISABLED
    ```

The kill switch is removed last, after the secrets are gone. This ordering leaves no window in
which a production deploy can run using throwaway credentials.

## Recording the outcome

In issue #183's **Evidence** block, record the verification PR numbers, exact GitHub Actions run
links, final resource-absence evidence, and a short pass/fail verdict. Record the sanitized probe
measurement in `TESTING.md` as described above. Do not record a Cloudflare API token, account ID,
generated admin token, read token, secret-file contents, authenticated dashboard URL, raw action
log containing credentials, or screenshot that exposes any of them. Redact an identifier before
sharing evidence; if a credential was exposed, revoke and rotate it rather than merely editing the
record.
