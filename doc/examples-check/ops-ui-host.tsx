import type { HistoryPage, StashClient } from "@takazudo/zudo-history-stash";
import {
  defaultStashHrefFor,
  HistoryList,
  StashUiProvider,
  type StashAnchorProps,
  type StashHrefFor,
} from "@takazudo/zudo-history-stash-ui";

const hrefFor: StashHrefFor = (route) => `/operator${defaultStashHrefFor(route)}`;

function Anchor({ children, href, ...props }: StashAnchorProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

export interface OpsHistoryHostProps {
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  stash: string;
  path: string;
  page: HistoryPage;
  onLoadMore: () => void;
}

export function OpsHistoryHost({
  client,
  clientForSignal,
  stash,
  path,
  page,
  onLoadMore,
}: OpsHistoryHostProps) {
  return (
    <StashUiProvider
      client={client}
      clientForSignal={clientForSignal}
      hrefFor={hrefFor}
      Anchor={Anchor}
    >
      <HistoryList stash={stash} path={path} page={page} onLoadMore={onLoadMore} />
    </StashUiProvider>
  );
}
