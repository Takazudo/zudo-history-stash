# Changelog

All notable changes to `@takazudo/zudo-history-stash` are documented in this file.

The format is based on Keep a Changelog, and release notes are generated from the changelog MDX pages.

## [0.2.0] - 2026-08-29

- Add `commits(stash)`, `changeSets(stash)`, and `files(stash).snapshot()` APIs over fetch and named
  RPC transports.
- Expose atomic conflict details through `conflicts[]` and the `isCommitConflict` guard; no automatic
  multi-path stale retry is performed.
- Require `commitId` in version, history, change-feed, and live-event types and extend the fake and
  conformance surfaces to preserve all-or-none behavior.

## [0.1.0] - 2026-08-25

- Add the isomorphic `createStashClient` API for Node.js, browsers, and Cloudflare Worker service
  bindings.
- Cover administrator, token, import, file, history, change-feed, stored-diff, and candidate-diff
  routes with typed business outcomes.
- Add representation-cache handling, automatic idempotency keys, replay metadata, and bounded
  `putLatest` conflict retries.
- Add capability-selected binary/large-object uploads, streamed current/historical downloads,
  resumable session controls, bounded materializers, observed progress, and Request/Response RPC
  stream flow control.
