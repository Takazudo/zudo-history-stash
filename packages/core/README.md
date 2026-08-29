# @takazudo/zudo-history-stash-core

Runtime-agnostic types, schemas, validators, hashes, limits, and diff helpers shared by the
zudo-history-stash packages.

This package is not published to npm yet. Clone the repository and build the workspace packages
from the workspace root with `pnpm install` followed by `pnpm build:libs`. Then depend on the
workspace package at `packages/core`, or run `pnpm pack` in that directory and install the
generated tarball.

See the [repository documentation](https://github.com/Takazudo/zudo-history-stash/tree/main/docs)
for the API reference and architecture guides.

The core contract keeps representation (`text | binary`), content access (`inline | raw | deleted`),
transfer (`json | single | multipart`), storage (`d1 | r2`), and diff eligibility independent.
`MAX_BODY_BYTES` is the fixed 5,000,000-byte compatibility JSON/commit/import text limit. The
default `JSON_INLINE_MAX_BYTES` setting currently has the same value, but only controls inline text
access; neither is a universal file limit or turns larger valid UTF-8 into binary. The default D1
inline threshold is 524,288 bytes, the diff limit is 524,288 bytes per side, and the raw file ceiling is
100,000,000 bytes (configurable up to 1,073,741,824 bytes for correctness validation). The latter
is not a performance certification. See `limits.ts` and the generated capabilities response for
the exact numeric exports.
