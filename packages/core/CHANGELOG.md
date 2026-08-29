# Changelog

All notable changes to `@takazudo/zudo-history-stash-core` are documented in this file.

The format is based on Keep a Changelog, and release notes are generated from the changelog MDX pages.

## [0.2.0]

- Add atomic multi-path commits, commit-boundary snapshots, immutable change sets, commit reverts,
  binary candidates, and stored-version copy entries.
- Proposals were removed; use a one-entry change set for the equivalent review workflow.
- Make `commitId` required on every version and change-feed item, including writes made through
  single-path routes.
- Add `commit-conflict`, `change-set-expired`, and `change-set-closed` outcomes and the shared commit
  and change-set limits.

## [0.1.0]

- Define the complete v1 route table, principals, request/response types, strict Zod schemas, and
  stable error codes.
- Add shared stash/path validation, UTF-8 limits, canonical hashing, representation ETags, and
  conditional-request helpers.
- Add bounded stored and candidate text diffs with unified output, structured hunks, statistics,
  truncation, and explicit oversized states.
