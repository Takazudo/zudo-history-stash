import type { HistoryPage } from "@takazudo/zudo-history-stash";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  HistoryList as RelocatedHistoryList,
  useFileHistory,
  type RollbackSuccess,
} from "../../../../packages/ui/src/components/relocated.js";
import { defaultStashHref } from "../../../../packages/ui/src/provider/routes.js";
import { StashUiProvider } from "../../../../packages/ui/src/provider/stash-ui-provider.js";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { ViewerAnchor } from "./relocated-link-bridge.js";
import "../../../../packages/ui/src/styles/primitives.css";
import "../../../../packages/ui/src/styles/relocated.css";
import "../../../../packages/ui/src/styles/stateful.css";
import "./history-list.css";

export interface HistoryListProps {
  client: ViewerStashClient;
  stash: string;
  path: string;
  page: HistoryPage;
  viewedVersion?: number;
  onRollbackComplete?: () => void;
}

interface HistoryListBridgeProps extends Omit<HistoryListProps, "client" | "onRollbackComplete"> {
  onRollbackComplete: (success: RollbackSuccess) => void;
}

function HistoryListBridge({
  stash,
  path,
  page,
  viewedVersion,
  onRollbackComplete,
}: HistoryListBridgeProps) {
  const history = useFileHistory(stash, path, { initialPage: page });
  if (history.state !== "ready") return null;
  return (
    <RelocatedHistoryList
      loadMoreError={history.loadMoreError}
      loadingMore={history.loadingMore}
      page={history.page}
      path={path}
      stash={stash}
      viewedVersion={viewedVersion}
      onLoadMore={history.loadMore}
      onRollbackComplete={onRollbackComplete}
    />
  );
}

/** Keep current Viewer client and router props compatible until #99 installs the provider bridge. */
export function HistoryList({
  client,
  onRollbackComplete,
  stash,
  path,
  page,
  ...props
}: HistoryListProps) {
  const navigate = useNavigate();
  const clientForSignal = useCallback((signal: AbortSignal) => client.withSignal(signal), [client]);
  const completeRollback = useCallback(
    (_success: RollbackSuccess) => {
      onRollbackComplete?.();
      navigate(defaultStashHref({ kind: "file", stash, path }));
    },
    [navigate, onRollbackComplete, path, stash],
  );

  return (
    <StashUiProvider Anchor={ViewerAnchor} client={client} clientForSignal={clientForSignal}>
      <HistoryListBridge
        {...props}
        onRollbackComplete={completeRollback}
        page={page}
        path={path}
        stash={stash}
      />
    </StashUiProvider>
  );
}
