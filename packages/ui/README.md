# `@takazudo/zudo-history-stash-ui`

Router-independent React components and state hooks for History Stash hosts. The package supplies
the history, diff, editing, file-creation, deletion, rollback, restore, and token-management UI used
by the standalone Viewer without taking ownership of routing or authentication.

## Install

```bash
pnpm add @takazudo/zudo-history-stash-ui @takazudo/zudo-history-stash \
  @takazudo/zudo-history-stash-core react react-dom
```

Import the component stylesheet once in the host entry point, after the host's design tokens:

```ts
import "./tokens.css";
import "@takazudo/zudo-history-stash-ui/styles.css";
```

Copy `styles/tokens.example.css` from the installed package as a starting point and adapt the
values in a host-owned stylesheet. It is framework-independent plain CSS: it only defines custom
properties and the theme activation selectors; it does not import Tailwind or inject a reset. The
example deliberately matches the standalone Viewer. See
the complete [design-token contract](https://github.com/Takazudo/zudo-history-stash/blob/main/docs/design-tokens.md)
for the stable token names, CSS layers, and override rules.

The package consumes these public token groups:

- Color and effects: `--theme-canvas`, `--theme-surface`, `--theme-surface-raised`,
  `--theme-surface-muted`, `--theme-ink`, `--theme-ink-strong`, `--theme-ink-muted`,
  `--theme-border`, `--theme-border-strong`, `--theme-accent`, `--theme-accent-subtle`,
  `--theme-accent-soft`, `--theme-on-accent`, the `--theme-hover-*`, `--theme-active-*`,
  `--theme-success*`, `--theme-error*`, `--theme-info*`, `--theme-warning*`,
  `--theme-diff-*`, `--theme-focus`, `--theme-selection`, `--theme-transparent`,
  `--overlay-bg`, and `--shadow-dialog` roles.
- Components: `--header-*`, `--button-primary-*`, `--button-secondary-*`,
  `--button-danger-*`, `--button-active-*`, `--table-*`, `--badge-*`, `--input-bg`, and
  `--input-border`.
- Type: `--font-sans`, `--font-family-mono`, `--text-xs` through `--text-xl`, `--line-tight`,
  `--line-body`, and `--line-code`.
- Geometry: `--space-xs` through `--space-4xl`, `--hsp-*`, `--vsp-*`, `--row-dense`,
  `--control-height`, `--radius-sm`, `--radius-md`, `--border-hairline`, and
  `--active-indicator-width`.

`--palette-*` values are private implementation inputs; package component CSS never consumes them
directly. The linked contract is the authoritative exact list.

## Provider contract

Mount one `StashUiProvider` above package hooks and components:

| Prop              | Contract                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- |
| `client`          | A configured `StashClient` used for ordinary requests and the `/v1/me` capability check |
| `clientForSignal` | Optional factory returning a client bound to an `AbortSignal`; defaults to `client`     |
| `hrefFor`         | Optional route-to-URL mapper; defaults to the documented Viewer URL scheme              |
| `Anchor`          | Optional host link component receiving `href`; defaults to a plain HTML anchor          |

This minimal host composes history, a core diff model, and the editor:

```tsx
import { buildDiffModel, type DiffHunk } from "@takazudo/zudo-history-stash-core";
import type { StashClient } from "@takazudo/zudo-history-stash";
import {
  DiffPane,
  EditWorkbench,
  HistoryList,
  StashUiProvider,
  useFileHistory,
  type StashAnchorProps,
} from "@takazudo/zudo-history-stash-ui";

const Anchor = ({ href, ...props }: StashAnchorProps) => <a href={href} {...props} />;
function Screen({ hunks }: { hunks: readonly DiffHunk[] }) {
  const history = useFileHistory("docs", "guide.md");
  if (history.state !== "ready") return <p>Loading…</p>;
  return (
    <>
      <HistoryList
        stash="docs"
        path="guide.md"
        page={history.page}
        loadingMore={history.loadingMore}
        loadMoreError={history.loadMoreError}
        onLoadMore={history.loadMore}
      />
      <DiffPane
        model={buildDiffModel(hunks)}
        fromLabel="v1"
        toLabel="draft"
        layout="unified"
        marks
        wrap
      />
      <EditWorkbench stash="docs" path="guide.md" />
    </>
  );
}
export const Host = ({ client, hunks }: { client: StashClient; hunks: DiffHunk[] }) => (
  <StashUiProvider client={client} Anchor={Anchor}>
    <Screen hunks={hunks} />
  </StashUiProvider>
);
```

The checked version of this composition lives in `examples-check/host.tsx` in the source
repository and is compiled by `pnpm check:examples`.

For React Router, pass an `Anchor` backed by `Link` and a route-aware `hrefFor`. The package itself
does not import a router. `defaultStashHrefFor` covers the standalone URL scheme; a mounted host can
prefix or replace it.

## Public surface

The package exports provider capability hooks, request/state hooks, complete workflow components,
stateless display components, and square form/table/dialog primitives from its root. Import public
types from the same root. The exact root surface is pinned by `src/exports.test.ts` so internal
modules are not an accidental API.

Use `useCanWrite` and `useIsAdmin` to reflect server capabilities; do not infer privileges from a
route. Components still enforce their own capability gates. `useStashClientForSignal` should be
used for abortable loads, and `useStashHref` keeps component links host-aware.

## Credentials and errors

Browser-direct integrations should use read credentials only. A write token can mutate every path
in its stash, and an admin token can manage credentials; keep either behind a trusted operator
surface such as the Viewer protected by Cloudflare Access. The provider neither stores tokens nor
implements login/logout. The host owns credential storage, request transport, and its response to
`401`; package components render typed API failures returned by the supplied client.

Workbench drafts are retained in the tab's `sessionStorage` and keyed by stash and path, not by
credential. This preserves unsaved work across navigation and client re-renders for one principal,
but it also makes credential changes an explicit host responsibility. Import
`clearWorkbenchDraftsForCredentialChange` from the package root and call it immediately before:

- removing the active credential during logout or `401` handling; and
- installing a validated credential during login, account switching, or credential replacement.

Cleanup should run at both boundaries so a later principal cannot restore a previous principal's
draft, even when credential storage was cleared independently. A `false` result means draft cleanup
could not be confirmed. Logout must still deactivate the runtime credential and client in a
`finally` path. Attempt persisted-credential removal independently and surface a failure: the stored
credential can become active again after reload, so the operator should close the tab and clear its
site data. Do not install or activate a new credential until draft cleanup and credential persistence
both succeed.

```ts
import { clearWorkbenchDraftsForCredentialChange } from "@takazudo/zudo-history-stash-ui";

function logOut() {
  const draftsCleared = clearWorkbenchDraftsForCredentialChange();
  let credentialRemoved = false;
  try {
    credentialRemoved = removePersistedCredential();
  } catch {
    credentialRemoved = false;
  } finally {
    deactivateCredentialInMemory();
  }
  if (!draftsCleared || !credentialRemoved) showCredentialStorageWarning();
}

function installValidatedCredential(credential: string) {
  if (!clearWorkbenchDraftsForCredentialChange()) return false;
  if (!storeCredential(credential)) return false;
  activateCredentialInMemory(credential);
  return true;
}
```

The Viewer integration and its operational credential guidance are documented in the repository's
[Viewer operations runbook](https://github.com/Takazudo/zudo-history-stash/blob/main/docs/viewer-operations.md).
