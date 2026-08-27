import type {
  ListProposalsOptions,
  ProposalListResponse,
  ProposalRecord,
  ProposalStatus,
} from "@takazudo/zudo-history-stash";
import { useEffect, useId, useRef, useState } from "react";
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
}: ProposalListProps) {
  const titleId = useId();
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const mountedRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ProposalListState>(INITIAL_STATE);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    loadingMoreRef.current = false;
    setState(INITIAL_STATE);

    void clientForSignal(controller.signal)
      .proposals(stash)
      .list(listOptions({ status, path, limit }))
      .then((result) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (!result.ok) throw result;
        setState({
          ...result.value,
          error: null,
          loading: false,
          loadingMore: false,
          loadMoreError: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setState({
          ...INITIAL_STATE,
          error,
          loading: false,
        });
      });

    return () => controller.abort();
  }, [attempt, clientForSignal, limit, path, refreshRevision, stash, status]);

  function retry() {
    setAttempt((current) => current + 1);
  }

  async function loadMore() {
    if (state.nextAfter === null || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setState((current) => ({ ...current, loadingMore: true, loadMoreError: null }));
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;

    try {
      const result = await clientForSignal(controller.signal)
        .proposals(stash)
        .list(listOptions({ status, path, limit, after: state.nextAfter }));
      if (controller.signal.aborted || !mountedRef.current) return;
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
      if (!controller.signal.aborted && mountedRef.current) {
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
  }

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
