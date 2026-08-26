import { buildDiffModel, type DiffHunk } from "@takazudo/zudo-history-stash-core";
import type { StashClient } from "@takazudo/zudo-history-stash";
import {
  clearWorkbenchDraftsForCredentialChange,
  defaultStashHrefFor,
  DiffPane,
  EditWorkbench,
  HistoryList,
  StashUiProvider,
  useFileHistory,
  type StashAnchorProps,
  type StashHrefFor,
} from "@takazudo/zudo-history-stash-ui";

const stash = "docs";
const path = "guides/start.md";
const hrefFor: StashHrefFor = (route) => `/operator${defaultStashHrefFor(route)}`;

export function removeHostCredential(removeCredential: () => void): void {
  clearWorkbenchDraftsForCredentialChange();
  removeCredential();
}

export function installHostCredential(installCredential: () => void): boolean {
  if (!clearWorkbenchDraftsForCredentialChange()) return false;
  installCredential();
  return true;
}

function Anchor({ href, ...props }: StashAnchorProps) {
  return <a href={href} {...props} />;
}

function PackageSurface({ hunks }: { hunks: readonly DiffHunk[] }) {
  const history = useFileHistory(stash, path);
  if (history.state === "loading") return <p>Loading history…</p>;
  if (history.state === "error") return <p>History unavailable.</p>;

  return (
    <>
      <HistoryList
        loadMoreError={history.loadMoreError}
        loadingMore={history.loadingMore}
        page={history.page}
        path={path}
        stash={stash}
        onLoadMore={history.loadMore}
      />
      <DiffPane
        fromLabel="v1"
        layout="unified"
        marks={true}
        model={buildDiffModel(hunks)}
        toLabel="draft"
        wrap={true}
      />
      <EditWorkbench path={path} stash={stash} />
    </>
  );
}

export function HostExample({
  client,
  clientForSignal,
  hunks,
}: {
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  hunks: readonly DiffHunk[];
}) {
  return (
    <StashUiProvider
      Anchor={Anchor}
      client={client}
      clientForSignal={clientForSignal}
      hrefFor={hrefFor}
    >
      <PackageSurface hunks={hunks} />
    </StashUiProvider>
  );
}
