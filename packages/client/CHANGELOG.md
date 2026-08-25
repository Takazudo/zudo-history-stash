# Changelog

## 0.1.0 — 2026-08-25

- Add the isomorphic `createStashClient` API for Node.js, browsers, and Cloudflare Worker service
  bindings.
- Cover administrator, token, import, file, history, change-feed, stored-diff, and candidate-diff
  routes with typed business outcomes.
- Add representation-cache handling, automatic idempotency keys, replay metadata, and bounded
  `putLatest` conflict retries.
