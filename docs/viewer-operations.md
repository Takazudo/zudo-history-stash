# Viewer operations

The Viewer is a trusted operator surface for browsing and changing History Stash data. Deploy it
behind Cloudflare Access (or an equivalent identity-aware proxy), restrict the upstream stash
binding to the Viewer, and grant only the capability an operator needs. The application capability
check complements perimeter authentication; it does not replace it.

## Credentials and capability boundaries

| Principal capability | Viewer access                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| unauthenticated      | Login prompt only; protected routes make no data request beyond `/v1/me` |
| `read`               | Home, stash, file, history, and diff views                               |
| `write`              | Read access plus new file, edit, delete, rollback, and tombstone restore |
| `admin`              | Write access plus token minting, listing, and revocation                 |

A token is a bearer credential. A write token can change every path in its stash, and an admin
token can create or revoke other credentials. Never expose either in public browser code, source
control, analytics, support captures, or URLs. Prefer a short-lived Access session in front of the
Viewer and provision the narrowest stash token needed by the operator deployment.

The current Viewer stores a manually entered token in the tab's `sessionStorage` under
`zhs.token`. It is not persisted across browser sessions. Logout and authentication failure always
deactivate the token and client in the running page, then attempt to remove the stored token. If the
browser blocks that removal, the login page warns that a reload can restore the old token; close the
tab and clear its site data before continuing. Always do that after using a shared workstation. A
server-side session or BFF is an optional host architecture, not behavior supplied by the UI package.

## Operational recovery

### Stale edits

Writes use compare-and-set semantics. If the head moves while an editor is open, the Viewer keeps
the draft and reports the new head instead of overwriting it. Reload the current head, compare it
with the retained draft, incorporate the concurrent change, and submit a new save operation. Do
not replay the stale request or reuse its idempotency key for different content.

### Drafts

Unsaved editor text is held per tab in `sessionStorage` using keys shaped like
`zhs.draft.<stash>.<path>`. A draft records the source version and content needed to restore the
workbench. It is cleared after a successful save or an explicit discard, and Viewer attempts to
clear every draft before logout and before installing a validated credential. If browser storage
blocks cleanup, the Viewer deactivates the current in-memory credential, warns on the login page,
and will not activate another credential until cleanup succeeds. Treat draft content as sensitive
and avoid shared browser profiles.

### One-time token secrets

The token-management page displays a newly minted secret once. Copy it directly to the intended
secret store and verify access before leaving the page. History Stash cannot recover a lost secret:
revoke its token record and mint a replacement. Revocation takes effect for subsequent requests;
investigate and revoke immediately if a secret may have escaped. Mint and revoke operations require
an admin principal.

The current API does not promise token expiry or rate limiting. Do not invent either policy in a
host. Those controls are tracked in [issue #110](https://github.com/Takazudo/zudo-history-stash/issues/110);
until they land, use Access policy duration, narrow credentials, and monitoring as deployment
controls.

## Deep links

The Viewer uses these stable, bookmarkable paths:

- `/` — stash index
- `/s/:stash` — one stash's file list
- `/s/:stash/f/*path?version=N` — file content and history, optionally at a stored version
- `/s/:stash/diff/*path?from=N&to=M|head&context=N` — stored-version comparison
- `/s/:stash/edit/*path?from=N` — write-gated editor, optionally seeded from an older version
- `/s/:stash/new` — write-gated new-file form
- `/s/:stash/tokens` — admin-only token management

Keep the full query string when sharing a historical file or diff. A direct request to a denied
write/admin route stays capability-gated and must not prefetch stash data before `/v1/me` confirms
the principal.

## Raw upload, preview, and download recovery

The new-file route offers both the text editor and the capability-driven raw upload form. Uploads
keep representation (`text` or `binary`), transfer (`json`, `single`, or `multipart`), content
access (`inline`, `raw`, or `deleted`), and storage tier (`d1` or `r2`) independent. A body above
5,000,000 bytes is not automatically binary: valid UTF-8 can remain `text` when it is uploaded as
raw content. The form reads `/v1/capabilities`, uses a single request up to the configured single
limit, and uses resumable multipart parts above it. A write token and the expected head are still
required; a stale head is a conflict, not an invitation to overwrite.

File pages fetch raw content with the authenticated client. Valid UTF-8 is previewed only up to the
configured text-preview bound; larger text remains text but is download-only. Binary content is
download-only except for bounded, allowlisted PNG/JPEG/WebP/GIF previews. Active content is never
embedded. Deleted versions expose metadata and a raw-history link only; a deleted head is not
silently treated as an empty file.

For a large authenticated download, a browser with the File System Access API streams the response
directly into the operator-selected file and does not buffer the R2-scale body. Unsupported
browsers deliberately refuse a raw download above **32 MiB (33,554,432 bytes)** instead of
buffering it into a Blob. A failed or cancelled transfer closes the response; retry from the file
page, and use a range request or an external trusted client for recovery rather than copying the
bearer token into a URL. A successful download is not proof that a later version is unchanged:
use the displayed hash/ETag and version, and re-fetch with conditional headers when checking
history.

## Operator checklist

1. Confirm the Viewer is covered by the intended Access application and identity policy.
2. Verify the service binding reaches the expected stash environment.
3. Sign in with the least-privileged token that supports the task.
4. Resolve stale edits by reloading and comparing; never bypass the head-version fence.
5. Move newly minted secrets to the approved secret store immediately.
6. Revoke unused or suspected credentials and clear the Viewer session when finished.
