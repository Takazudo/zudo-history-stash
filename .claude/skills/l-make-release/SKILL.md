---
name: l-make-release
description: >-
  Use when asked to "cut a release", "bump version", "release the packages", or
  "make npm release" using the repository's guarded latest-only workflow.
user-invocable: true
argument-description: major | minor | patch | X.Y.Z
---

# Make a release

## What it does

Prepare, publish, and verify one stable release of all three npm packages from `main`, using the release
commands dispatched by [`scripts/release.sh`](../../../scripts/release.sh), the implementations in
[`scripts/release/`](../../../scripts/release/), and the tag-triggered
[`release.yml`](../../../.github/workflows/release.yml) workflow. Treat publishing and tag pushes as
irreversible operations: stop at every blocking condition below, but continue through advisory
output after surfacing it.

## Auto-proceed vs block

Classify the invocation before changing files or pushing anything. `<mode>` below means the single
argument supplied to this skill and must be `major`, `minor`, `patch`, or an explicit, strictly
greater plain SemVer `X.Y.Z` with no prerelease or build suffix.

| Situation                                                                                                                                               | Action                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The user deliberately invoked `/l-make-release <mode>` on a cold start, the tree is clean, and the requested mode does not conflict with commit history | **Auto-proceed.** State the requested mode and begin the ordered steps.                                      |
| A `feat!` subject or `BREAKING CHANGE` body exists in the unreleased commits, but `<mode>` is `patch`                                                   | **Block for confirmation.** Show the breaking commits and ask whether to use `major` or an explicit version. |
| `pnpm release:check` reports a resume candidate whose SHA is not the current `HEAD`                                                                     | **Block for confirmation.** Show both SHAs; do not tag either revision.                                      |
| The working tree is dirty at the start or when a guarded command requires it clean                                                                      | **Block for confirmation.** Show `git status --short`; do not discard, stash, or include unrelated work.     |
| The request was only a loosely inferred phrase such as “we should release soon,” rather than a deliberate invocation with an explicit mode              | **Block for confirmation.** Ask for exactly one release mode or explicit version.                            |
| `pnpm release:verify` reports historical dist-tag warnings, while `latest` points to the new version and no other tag points to it                      | **Surface and proceed.** Include the warnings in the final report; they are advisory.                        |
| `pnpm release:check` reports a resume candidate at the current `HEAD`, and the committed release diff is valid                                          | **Surface and proceed.** Skip changelog, bump, gate, and commit work; resume with push/CI/tag as applicable. |

Any unlisted error is blocking. Explain the failed command and preserve the repository state for
recovery. Never interpret silence, a guessed version, or an ambiguous resume as approval.

## Ordered steps

Run from the repository root on `main`.

1. **Preflight and history.** Run:

   ```bash
   pnpm release:check
   ```

   This checks GitHub authentication, fetches tags, requires a clean `main`, prints the current
   version, groups commits since the latest `v*` tag (or from the root commit for the first
   release), marks breaking commits, and reports a possible resume. Apply the decision table before
   continuing.

2. **Propose the target.** From the current version, `<mode>`, and grouped commit list, propose
   `X.Y.Z`. Show the proposed version and the full grouped list to the user. An explicit `X.Y.Z`
   remains subject to the history-conflict rule and must be strictly greater than the current
   version. Set shell variables for later commands:

   ```bash
   MODE="$ARGUMENTS"
   VERSION=X.Y.Z
   TAG="v$VERSION"
   ```

3. **Write all three changelogs.** Add a concise English `## X.Y.Z — YYYY-MM-DD` section to
   `packages/core/CHANGELOG.md`, `packages/client/CHANGELOG.md`, and `packages/ui/CHANGELOG.md`.
   Categorise relevant entries
   under `### Breaking`, `### Features`, `### Fixed`, and `### Other`; omit empty categories.
   Describe each package's user-visible changes, not merely commit subjects.

   Before adding a heading, search the complete file. If that exact version already has a section,
   reuse and update it instead of adding another. This is required for the first release: all three
   changelogs already contain `0.1.0`, so reuse those sections. Never create a duplicate heading,
   reorder sections, or rewrite an older release section.

4. **Bump the six version-bearing files and regenerate the OpenAPI artifact.** The generated
   document's `info.version` is intentionally pinned to the core package version, so it is part of
   the atomic release diff. Run the requested mode or explicit version exactly:

   ```bash
   pnpm release:bump "$MODE"
   ```

   The command updates all three package manifests and all three exported `VERSION` constants, regenerates
   `docs/openapi.json`, installs dependencies, and stops if the lockfile changes. Do not hand-edit
   these six version values or the generated OpenAPI artifact.

5. **Gate before committing.** Run both checks after the changelog and version changes and before
   creating the release commit:

   ```bash
   pnpm release:gate
   pnpm format:check
   ```

   Fix only release-scope failures, then rerun both commands. The gate builds, inspects, installs,
   and dry-runs publication of the package tarballs; it does not publish.

6. **Create one atomic release commit.** Stage exactly these ten paths and commit once:

   ```bash
   git add packages/core/package.json packages/client/package.json packages/ui/package.json \
     packages/core/src/index.ts packages/client/src/index.ts packages/ui/src/index.ts \
     packages/core/CHANGELOG.md packages/client/CHANGELOG.md packages/ui/CHANGELOG.md \
     docs/openapi.json
   git commit -m "chore(release): bump to v$VERSION"
   ```

   Lefthook may reformat and re-stage Markdown. Do not use `--amend`.

7. **Inspect the committed diff.** Run:

   ```bash
   git status --short
   git diff --name-only HEAD^ HEAD
   git diff --check HEAD^ HEAD
   git show --stat --oneline HEAD
   git diff HEAD^ HEAD -- packages/core/package.json packages/client/package.json packages/ui/package.json \
     packages/core/src/index.ts packages/client/src/index.ts packages/ui/src/index.ts \
     packages/core/CHANGELOG.md packages/client/CHANGELOG.md packages/ui/CHANGELOG.md \
     docs/openapi.json
   ```

   Require an empty status and exactly the six version-bearing files, the three changelogs, and the
   generated OpenAPI document in the name-only output (ten paths total). Confirm all six versions and
   `docs/openapi.json`'s `info.version` equal `X.Y.Z`, each changelog has exactly one heading for
   it, older sections are unchanged, and no hook touched another file. If any other path changed,
   stop; do not push.

8. **Push `main` and wait for CI.** Run:

   ```bash
   git push origin main
   ```

   Wait for CI on the pushed `HEAD` to succeed. `release:tag` independently checks that local
   `HEAD` equals `origin/main` and polls the latest `ci.yml` run for that commit.

9. **Create and push the guarded tag.** Run:

   ```bash
   pnpm release:tag
   ```

   This creates `vX.Y.Z` at `HEAD` only after CI succeeds and pushes the tag to `origin`. The tag
   push starts `release.yml`.

10. **Watch the tag's release workflow.** Resolve the run by workflow, push event, and tagged
    commit, then watch that exact run:

    ```bash
    RUN_ID=""
    for attempt in $(seq 1 30); do
      RUN_ID="$(gh run list --workflow release.yml --event push \
        --commit "$(git rev-parse "$TAG^{commit}")" --limit 1 \
        --json databaseId --jq '.[0].databaseId')"
      test -n "$RUN_ID" && break
      sleep 2
    done
    test -n "$RUN_ID"
    gh run watch "$RUN_ID" --exit-status
    ```

    Do not create the GitHub release until this run succeeds. The workflow publishes core first,
    waits for it to become visible, publishes client, waits for it, and then publishes UI;
    exact-version safeguards make reruns idempotent.

11. **Create release notes and the GitHub release.** Extract only this version's core changelog
    body into a temporary file, inspect it, then create the release:

    ```bash
    NOTES_FILE="$(mktemp)"
    trap 'rm -f -- "$NOTES_FILE"' EXIT
    awk -v version="$VERSION" '
      index($0, "## " version " — ") == 1 { in_section = 1; next }
      in_section && /^## / { exit }
      in_section { print }
    ' packages/core/CHANGELOG.md >"$NOTES_FILE"
    test -s "$NOTES_FILE"
    gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES_FILE"
    ```

    The extracted notes must contain only the intended `X.Y.Z` section body. Remove the temporary
    file after the release is created.

12. **Verify npm and report.** Run:

    ```bash
    pnpm release:verify
    npm dist-tag ls @takazudo/zudo-history-stash-core
    npm dist-tag ls @takazudo/zudo-history-stash
    npm dist-tag ls @takazudo/zudo-history-stash-ui
    gh release view "$TAG" --json url --jq .url
    ```

    Report the core, client, and UI versions, all three complete `npm dist-tag ls` outputs, any historical
    dist-tag warnings, the workflow result, and the GitHub release URL. Finally suggest running
    `/dev-bump-zudo-deps` in consumer projects.

## Recovery playbook

| Failure                                                                   | Recovery                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tag was pushed, but `release.yml` failed before any package published | If the failure is transient and the tagged commit is correct, use `gh run rerun <run-id>` and `gh run watch <run-id> --exit-status` to retry the workflow for the existing tag. A rerun checks out the immutable tagged commit; a fix-forward on `main` cannot repair that run. If code or workflow changes are required, fix forward on `main` and cut a new patch release through the complete flow. Never move or recreate the existing tag. |
| Core published, but client failed                                         | If the failure is transient and the tagged commit is correct, rerun the same workflow; the exact-version safeguard skips core and retries client before UI. If code or workflow changes are required, fix forward on `main` and cut a new patch release; leave the published core version intact.                                                                                                                                               |
| Core and client published, but UI failed                                  | Rerun the same workflow for the immutable tag; exact-version safeguards skip core and client and retry UI. If a code or workflow fix is required, fix forward and cut a new patch release. Never republish, unpublish, or retag the existing versions.                                                                                                                                                                                          |
| The wrong version was tagged or published                                 | Never delete a published version. Correct the files and changelogs on `main`, then publish a new patch release through the complete flow.                                                                                                                                                                                                                                                                                                       |
| CI is red on the bump commit before the tag exists                        | Fix forward on `main`, push, wait for CI on the new `HEAD`, then run `pnpm release:tag` again.                                                                                                                                                                                                                                                                                                                                                  |
| `release:check` finds the bump commit at current `HEAD` with no tag       | Verify its ten-path committed diff and that `origin/main` reaches the same commit, then resume at `pnpm release:tag`. If `HEAD` moved, block as specified above.                                                                                                                                                                                                                                                                                |

Do not “repair” release state by deleting registry versions, rewriting `main`, moving a tag, or
force-pushing. Preserve the failed run URL and command output in the recovery report.

## Rules

- Latest-only: never a `next` dist-tag. Use no prerelease modes or versions; publish stable plain
  SemVer through `latest` only.
- Never use `--amend` and never force-push.
- Never run `npm unpublish`.
- Never set `RELEASE_TEST_MODE`; it exists only for automated validation of release tooling on
  non-`main` branches.
- Never publish manually with `npm publish` or `pnpm publish`; the tag-triggered workflow owns
  publication.
- Never delete, recreate, or move a pushed release tag.
