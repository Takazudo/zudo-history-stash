# Contributing

Project-scope skills live under `.claude/skills/`.

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
publishing workflow, which publishes core, client, and UI in that order using the `latest` dist-tag
only; each dependent package waits for the preceding version to become visible. `next` is never
used. The bump also regenerates `docs/openapi.json`, whose `info.version` must be committed
atomically with all three package manifests, all three exported `VERSION` constants, and all three
generated changelogs.

Package changelog output is generated from the English release pages under
`doc/src/content/docs/changelog/`; never edit `packages/*/CHANGELOG.md` directly. Add the matching
Japanese page under `doc/src/content/docs-ja/changelog/` with the same frontmatter and structural
contract, format both sources, then run `pnpm build:doc` and
`pnpm --filter zudo-history-stash-doc check:changelog-drift`. A hand edit to a generated output is
rejected and should be repaired by rebuilding from the English source. Release bump validates the
generated bracket headings. Its exact sixteen-path staging allowlist covers six version-bearing
files, six bilingual version pages, three generated changelogs, and `docs/openapi.json`; the
committed diff may be a subset when a reused source page is already clean, but it must never contain
a path outside that allowlist. The pre-commit `format-mdx` hook is kept off generated changelogs by
the root `.mdx-formatter-ignore` file passed via `--ignore-path`; the `.mdx-formatter.json`
`exclude` list alone does not protect them because the formatter skips `exclude` for literal file
paths. An assertion in `doc/scripts/integration.test.mjs` keeps `.mdx-formatter-ignore` and the
`.mdx-formatter.json` `exclude` array in sync.

To re-run a partial release after a transient failure, re-run the workflow for the same tag push.
Its exact-version safeguards recognize packages that are already published and skip them, so the
remaining package or packages can finish in core → client → UI order. A rerun uses the immutable
tagged commit; if a code or workflow fix is required, fix forward on `main` and cut a new patch
release instead of trying to repair the old tag.

Running the workflow with `workflow_dispatch` exercises the complete chain as a dry run and never
publishes to npm.
