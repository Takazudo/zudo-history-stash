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

Before handoff, run `pnpm b4push` when the dependency stage supports it. CI also runs actionlint, package publint/attw checks, and the e2e mock/live lanes.
