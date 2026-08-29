# Changelog

All notable changes to `@takazudo/zudo-history-stash` are documented in this file.

The format is based on Keep a Changelog, and release notes are generated from the changelog MDX pages.

## [0.2.0]

- Add `commits(stash)`, `changeSets(stash)`, and `files(stash).snapshot()` APIs over fetch and named
  RPC transports.
- Preserve atomic `conflicts[]` on both `404 not-found` and `409 commit-conflict` results, and add the
  `isCommitConflict` guard for the `409 commit-conflict` branch specifically; no automatic multi-path
  stale retry is performed.
- Require `commitId` in version, history, change-feed, and live-event types and extend the fake and
  conformance surfaces to preserve all-or-none behavior.

## [0.1.0]

- Add the isomorphic `createStashClient` API for Node.js, browsers, and Cloudflare Worker service
  bindings.
- Cover administrator, token, import, file, history, change-feed, stored-diff, and candidate-diff
  routes with typed business outcomes.
- Add representation-cache handling, automatic idempotency keys, replay metadata, and bounded
  `putLatest` conflict retries.
- Add capability-selected binary/large-object uploads, streamed current/historical downloads,
  resumable session controls, bounded materializers, observed progress, and Request/Response RPC
  stream flow control.
