# Contributing

## Branches and merges

`main` is the parent branch. Integration branches use `base/**`; regular feature branches target the appropriate base branch. Use regular merges, never force-push a shared branch, and do not rewrite history that another contributor may have pulled.

## Pull requests

Keep a PR focused on one contract or implementation area. The description must include:

- a concise summary of the behavior changed;
- the exact test plan and commands run;
- a `NOT tested` list for browser, live infrastructure, deployment, or other checks intentionally not run;
- any migration, secret, binding, or follow-up integration note.

Do not put Cloudflare tokens, Worker secrets, or local `.dev.vars` files in commits. Update the relevant contract docs when a public API, stable viewer URL, or operational command changes.

When changing a route or schema: update `ROUTE_CONTRACTS` and `docs/api.md`, run
`pnpm openapi:generate`, and commit the regenerated `docs/openapi.json`.

Before handoff, run `pnpm b4push` when the dependency stage supports it. CI also runs actionlint, package publint/attw checks, and the e2e mock/live lanes.

## Releasing

Run `/l-make-release` to prepare a release. Pushing the resulting `vX.Y.Z` tag triggers the
publishing workflow, which publishes core first and then client using the `latest` dist-tag only;
`next` is never used.

To re-run a partial release, re-run the workflow for the same tag push. Its exact-version safeguards
recognize packages that are already published and skip them, so the remaining package can finish.
Running the workflow with `workflow_dispatch` exercises the complete chain as a dry run and never
publishes to npm.
