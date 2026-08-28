# ZUDO_DEPS_PINS

Provenance for artifacts vendored or generated from first-party (takazudo/zudolab) upstreams.
Updated by /dev-bump-zudo-deps on every sync — keep `pinned:` accurate.

## create-zudo-doc

- repo: zudolab/zudo-doc
- what: generated documentation scaffold reconciled through the repository's template-drift gate
- files: doc/CLAUDE.md, doc/package.json, doc/.zudo-doc.json, doc/pages/, doc/scripts/, doc/src/
- source: packages/create-zudo-doc/src/
- track: releases
- pinned: 7ca73f197021961603c22042748c23d9ce9d6c50 (v5.13.1)
- updated: 2026-08-29
- notes: doc/.template-drift-allowlist records intentional scaffold differences; preserve every listed adaptation during sync
