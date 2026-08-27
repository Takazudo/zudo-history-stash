import type {
  ListProposalsOptions,
  ProposalListResponse,
  ProposalRecord,
  ProposalStatus,
} from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Anchor, useStashClientForSignal, useStashHref } from "../provider/hooks.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { ErrorBanner } from "./error-banner.js";
import { LoadMore } from "./load-more.js";
import { PathText } from "./path-text.js";
import { RelativeTime } from "./relative-time.js";

type ProposalListStatus = ProposalStatus | "all";

export interface ProposalListProps {
  stash: string;
  status?: ProposalListStatus;
  path?: string;
  limit?: number;
  /** Host-owned revision used to refetch live-only proposal state without remounting the route. */
  refreshRevision?: number;
  /** Registers an awaited, abort-aware first-page refresh with a live host. */
  registerLiveRefresh?: (refresh: (signal: AbortSignal) => Promise<void>) => () => void;
}

interface ProposalListState extends ProposalListResponse {
  error: unknown | null;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: unknown | null;
}

const INITIAL_STATE: ProposalListState = {
  proposals: [],
  nextAfter: null,
  total: 0,
  error: null,
  loading: true,
  loadingMore: false,
  loadMoreError: null,
};

function proposalStatusLabel(status: ProposalStatus): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <span
      aria-label={`Proposal status: ${status}`}
      className={`zhs-proposal-status zhs-proposal-status--${status}`}
    >
      {proposalStatusLabel(status)}
    </span>
  );
}

function mergeProposals(
  current: readonly ProposalRecord[],
  incoming: readonly ProposalRecord[],
): ProposalRecord[] {
  const byId = new Map(current.map((proposal) => [proposal.id, proposal] as const));
  for (const proposal of incoming) byId.set(proposal.id, proposal);
  return [...byId.values()];
}

function listOptions({
  status,
  path,
  limit,
  after,
}: {
  status: ProposalListStatus;
  path?: string;
  limit?: number;
  after?: string;
}): ListProposalsOptions {
  return {
    status,
    ...(path === undefined ? {} : { path }),
    ...(limit === undefined ? {} : { limit }),
    ...(after === undefined ? {} : { after }),
  };
}

function filteredTotalText(total: number, status: ProposalListStatus, path?: string): string {
  const noun = total === 1 ? "proposal" : "proposals";
  const statusText = status === "all" ? "" : `${status} `;
  const pathText = path === undefined ? "" : ` for ${path}`;
  return `${total} ${statusText}${noun}${pathText}, newest first.`;
}

function ProposalListForTarget({
  stash,
  status = "open",
  path,
  limit,
  refreshRevision = 0,
  registerLiveRefresh,
}: ProposalListProps) {
  const titleId = useId();
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const mountedRef = useRef(true);
  const firstPagePendingRef = useRef(0);
  const lifecycleRef = useRef(new AbortController());
  const loadingMoreRef = useRef(false);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const requestTailRef = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<ProposalListState>(INITIAL_STATE);

  useEffect(() => {
    if (lifecycleRef.current.signal.aborted) lifecycleRef.current = new AbortController();
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current.abort();
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, []);

  const refresh = useCallback(
    (externalSignal?: AbortSignal): Promise<void> => {
      const lifecycleSignal = lifecycleRef.current.signal;
      firstPagePendingRef.current += 1;
      setState(INITIAL_STATE);
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
      loadingMoreRef.current = false;

      const execute = async (): Promise<void> => {
        const signal =
          externalSignal === undefined
            ? lifecycleSignal
            : AbortSignal.any([lifecycleSignal, externalSignal]);
        signal.throwIfAborted();
        if (!mountedRef.current) {
          throw new DOMException("The proposal list target is inactive.", "AbortError");
        }
        try {
          const result = await clientForSignal(signal)
            .proposals(stash)
            .list(listOptions({ status, path, limit }));
          signal.throwIfAborted();
          if (!mountedRef.current) {
            throw new DOMException("The proposal list target is inactive.", "AbortError");
          }
          if (!result.ok) throw result;
          setState({
            ...result.value,
            error: null,
            loading: false,
            loadingMore: false,
            loadMoreError: null,
          });
        } catch (error: unknown) {
          if (!signal.aborted && mountedRef.current) {
            setState({
              ...INITIAL_STATE,
              error,
              loading: false,
            });
          }
          throw error;
        }
      };

      const request = requestTailRef.current.then(execute, execute);
      const settled = request.finally(() => {
        firstPagePendingRef.current -= 1;
      });
      requestTailRef.current = settled.catch(() => undefined);
      return settled;
    },
    [clientForSignal, limit, path, stash, status],
  );

  useLayoutEffect(() => {
    if (registerLiveRefresh === undefined) return;
    return registerLiveRefresh((signal) => refresh(signal));
  }, [refresh, registerLiveRefresh]);

  useEffect(() => {
    void refresh().catch(() => {
      // The state channel owns initial-load failures; command callers receive their rejection.
    });
  }, [refresh, refreshRevision]);

  function retry() {
    void refresh().catch(() => undefined);
  }

  async function loadMore() {
    if (state.nextAfter === null || loadingMoreRef.current || firstPagePendingRef.current > 0) {
      return;
    }
    loadingMoreRef.current = true;
    setState((current) => ({ ...current, loadingMore: true, loadMoreError: null }));

    const execute = async (): Promise<void> => {
      const controller = new AbortController();
      const signal = AbortSignal.any([lifecycleRef.current.signal, controller.signal]);
      loadMoreControllerRef.current = controller;
      try {
        signal.throwIfAborted();
        const result = await clientForSignal(signal)
          .proposals(stash)
          .list(listOptions({ status, path, limit, after: state.nextAfter ?? undefined }));
        signal.throwIfAborted();
        if (!mountedRef.current) return;
        if (!result.ok) throw result;
        setState((current) => ({
          ...current,
          proposals: mergeProposals(current.proposals, result.value.proposals),
          nextAfter: result.value.nextAfter,
          total: result.value.total,
          loadingMore: false,
          loadMoreError: null,
        }));
      } catch (error: unknown) {
        if (!signal.aborted && mountedRef.current) {
          setState((current) => ({
            ...current,
            loadingMore: false,
            loadMoreError: error,
          }));
        }
      } finally {
        if (loadMoreControllerRef.current === controller) {
          loadMoreControllerRef.current = null;
          loadingMoreRef.current = false;
        }
      }
    };

    const request = requestTailRef.current.then(execute, execute);
    requestTailRef.current = request.catch(() => undefined);
    await request;
  }

  /*
   * The request functions above intentionally serialize and commit first-page/load-more work in
   * execution order. A live refresh also aborts an active pagination transport before it queues.
   */

  return (
    <section className="zhs-section-card zhs-proposal-list" aria-labelledby={titleId}>
      <header className="zhs-section-card__heading zhs-proposal-list__heading">
        <div>
          <h2 id={titleId}>Proposals</h2>
          <p>{filteredTotalText(state.total, status, path)}</p>
        </div>
      </header>

      {state.loading ? (
        <p className="zhs-proposal-list__empty" role="status">
          Loading proposals…
        </p>
      ) : null}

      {state.error !== null ? (
        <div className="zhs-proposal-list__error">
          <ErrorBanner error={state.error} onRetry={retry} title="Could not load proposals" />
        </div>
      ) : null}

      {!state.loading && state.error === null && state.proposals.length === 0 ? (
        <p className="zhs-proposal-list__empty">No proposals match this filter.</p>
      ) : null}

      {state.proposals.length > 0 ? (
        <div className="zhs-proposal-list__table-scroll">
          <Table className="zhs-proposal-table">
            <TableHead>
              <TableRow>
                <TableHeader scope="col">Path</TableHeader>
                <TableHeader scope="col">Author</TableHeader>
                <TableHeader scope="col">Message</TableHeader>
                <TableHeader scope="col">Time</TableHeader>
                <TableHeader scope="col">Status</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.proposals.map((proposal) => (
                <TableRow data-proposal-id={proposal.id} key={proposal.id}>
                  <TableCell className="zhs-proposal-table__path">
                    <Anchor href={hrefFor({ kind: "proposal", stash, id: proposal.id })}>
                      <PathText value={proposal.path} />
                    </Anchor>
                  </TableCell>
                  <TableCell className="zhs-proposal-table__author">
                    {proposal.author || <span className="zhs-muted">Unknown</span>}
                  </TableCell>
                  <TableCell className="zhs-proposal-table__message">
                    {proposal.message || <span className="zhs-muted">No message</span>}
                  </TableCell>
                  <TableCell className="zhs-proposal-table__time">
                    <RelativeTime value={proposal.createdAt} />
                  </TableCell>
                  <TableCell className="zhs-proposal-table__status">
                    <ProposalStatusBadge status={proposal.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {!state.loading && state.error === null ? (
        <footer className="zhs-section-card__footer zhs-proposal-list__footer">
          {state.loadMoreError !== null ? (
            <ErrorBanner
              error={state.loadMoreError}
              onRetry={() => void loadMore()}
              title="Could not load more proposals"
            />
          ) : null}
          <LoadMore
            hasMore={state.nextAfter !== null}
            loading={state.loadingMore}
            onLoadMore={() => void loadMore()}
          />
        </footer>
      ) : null}
    </section>
  );
}

export function ProposalList(props: ProposalListProps) {
  return (
    <ProposalListForTarget
      key={JSON.stringify([props.stash, props.status ?? "open", props.path, props.limit])}
      {...props}
    />
  );
}
