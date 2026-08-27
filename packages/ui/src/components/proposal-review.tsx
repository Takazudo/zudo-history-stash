import type {
  ApproveProposalResult,
  Current,
  ProposalDiffResult,
  ProposalRecord,
  StashProposalsClient,
  ProposalWithBody,
} from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDiffViewPreferences } from "../hooks/use-diff-view-preferences.js";
import { Anchor, useCanWrite, useStashClientForSignal, useStashHref } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Notice } from "../primitives/notice.js";
import { ApproveProposalDialog } from "./approve-proposal-dialog.js";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner } from "./error-banner.js";
import { PathText } from "./path-text.js";
import { ProposalStatusBadge } from "./proposal-list.js";
import { RejectProposalDialog } from "./reject-proposal-dialog.js";
import { RelativeTime } from "./relative-time.js";

export interface ProposalReviewProps {
  stash: string;
  proposalId: string;
  onApproved?: (result: ApproveProposalResult) => void;
  onRejected?: (record: ProposalRecord) => void;
}

type ReviewState =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; proposal: ProposalWithBody; diff: ProposalDiffResult };

type DecisionDialog = "approve" | "reject" | null;

async function readReview(
  proposal: StashProposalsClient,
  id: string,
): Promise<Extract<ReviewState, { state: "ready" }>> {
  const [recordResult, diffResult] = await Promise.all([proposal.get(id), proposal.diff(id)]);
  if (!recordResult.ok) throw recordResult;
  if (!diffResult.ok) throw diffResult;
  return { state: "ready", proposal: recordResult.value, diff: diffResult.value };
}

function baseLabel(version: number | null): string {
  return version === null ? "No base version" : `v${version}`;
}

function staleBaseLabel(version: number | null): string {
  return version === null ? "no head" : `v${version}`;
}

function headLabel(current: Current | null, approvedVersion: number | null): string {
  if (approvedVersion !== null) return `v${approvedVersion}`;
  return current === null ? "No current head" : `v${current.version}`;
}

function DecisionRecord({ stash, proposal }: { stash: string; proposal: ProposalWithBody }) {
  const titleId = useId();
  const hrefFor = useStashHref();
  if (proposal.status !== "applied" && proposal.status !== "rejected") return null;

  return (
    <section className="zhs-proposal-review__decision" aria-labelledby={titleId}>
      <h2 id={titleId}>Decision record</h2>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>
            <ProposalStatusBadge status={proposal.status} />
          </dd>
        </div>
        <div>
          <dt>Decided by</dt>
          <dd>{proposal.decidedBy || "Unknown principal"}</dd>
        </div>
        <div>
          <dt>Decided</dt>
          <dd>
            {proposal.decidedAt === null ? (
              "Unknown time"
            ) : (
              <RelativeTime value={proposal.decidedAt} />
            )}
          </dd>
        </div>
        {proposal.status === "applied" && proposal.appliedVersion !== null ? (
          <div>
            <dt>Applied version</dt>
            <dd>
              <Anchor
                href={hrefFor({
                  kind: "file",
                  stash,
                  path: proposal.path,
                  version: proposal.appliedVersion,
                })}
              >
                v{proposal.appliedVersion}
              </Anchor>
              {proposal.appliedChangeId === null ? null : ` · change ${proposal.appliedChangeId}`}
            </dd>
          </div>
        ) : null}
        {proposal.status === "rejected" ? (
          <div>
            <dt>Reason</dt>
            <dd>{proposal.decisionReason || "No reason recorded"}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function ProposalReviewForTarget({
  stash,
  proposalId,
  onApproved,
  onRejected,
}: ProposalReviewProps) {
  const titleId = useId();
  const diffTitleId = useId();
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  const capability = useCanWrite(stash);
  const preferences = useDiffViewPreferences();
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);
  const decisionControllerRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<ReviewState>({ state: "loading" });
  const [dialog, setDialog] = useState<DecisionDialog>(null);
  const [staleCurrent, setStaleCurrent] = useState<Current | null>(null);
  const [approvedVersion, setApprovedVersion] = useState<number | null>(null);
  const [decisionError, setDecisionError] = useState<unknown | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const readyDiff = review.state === "ready" ? review.diff : null;
  const readyHunks = readyDiff?.state === "ready" ? readyDiff.hunks : null;
  const model = useMemo(
    () => (readyHunks === null ? null : buildDiffModel(readyHunks)),
    [readyHunks],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
      decisionControllerRef.current?.abort();
      decisionControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++refreshSequenceRef.current;
    setReview({ state: "loading" });
    setDialog(null);
    setStaleCurrent(null);
    setApprovedVersion(null);
    setDecisionError(null);
    setDecisionPending(false);

    void readReview(clientForSignal(controller.signal).proposals(stash), proposalId)
      .then((value) => {
        if (
          !controller.signal.aborted &&
          mountedRef.current &&
          refreshSequenceRef.current === sequence
        ) {
          setReview(value);
        }
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          mountedRef.current &&
          refreshSequenceRef.current === sequence
        ) {
          setReview({ state: "error", error });
        }
      });

    return () => controller.abort();
  }, [attempt, clientForSignal, proposalId, stash]);

  async function refreshProposal() {
    decisionControllerRef.current?.abort();
    const controller = new AbortController();
    decisionControllerRef.current = controller;
    const sequence = ++refreshSequenceRef.current;
    setDecisionPending(true);
    setDecisionError(null);
    try {
      const result = await clientForSignal(controller.signal).proposals(stash).get(proposalId);
      if (!mountedRef.current || refreshSequenceRef.current !== sequence) return;
      if (!result.ok) throw result;
      setReview((current) =>
        current.state === "ready" ? { ...current, proposal: result.value } : current,
      );
    } catch (error: unknown) {
      if (mountedRef.current && refreshSequenceRef.current === sequence) setDecisionError(error);
    } finally {
      if (mountedRef.current && refreshSequenceRef.current === sequence) setDecisionPending(false);
      if (decisionControllerRef.current === controller) decisionControllerRef.current = null;
    }
  }

  function handleApproved(result: ApproveProposalResult) {
    setDialog(null);
    setApprovedVersion(result.appliedVersion);
    setDecisionError(null);
    setReview((current) =>
      current.state === "ready"
        ? {
            ...current,
            proposal: {
              ...current.proposal,
              status: "applied",
              appliedVersion: result.appliedVersion,
              appliedChangeId: result.appliedChangeId,
              decidedAt: result.createdAt,
            },
          }
        : current,
    );
    onApproved?.(result);
    void refreshProposal();
  }

  function handleStale(current: Current) {
    setDialog(null);
    setStaleCurrent(current);
    setDecisionError(null);
  }

  function handleExpired() {
    setDialog(null);
    setDecisionError(null);
    setReview((current) =>
      current.state === "ready"
        ? { ...current, proposal: { ...current.proposal, status: "expired" } }
        : current,
    );
  }

  function handleClosed() {
    setDialog(null);
    void refreshProposal();
  }

  function handleRejected(record: ProposalRecord) {
    setDialog(null);
    setDecisionError(null);
    setReview((current) =>
      current.state === "ready"
        ? { ...current, proposal: { ...current.proposal, ...record } }
        : current,
    );
    onRejected?.(record);
  }

  if (review.state === "loading") {
    return (
      <section className="zhs-proposal-review zhs-proposal-review--gate" aria-busy="true">
        <Notice>Loading proposal review…</Notice>
      </section>
    );
  }

  if (review.state === "error") {
    return (
      <section className="zhs-proposal-review zhs-proposal-review--gate">
        <ErrorBanner
          error={review.error}
          onRetry={() => setAttempt((current) => current + 1)}
          title="Could not load this proposal"
        />
      </section>
    );
  }

  const { proposal, diff } = review;
  const current = staleCurrent ?? diff.current;
  const stale = staleCurrent !== null || diff.stale;
  const closed = proposal.status === "applied" || proposal.status === "rejected";
  const expired = proposal.status === "expired";
  const writeReady = capability.ready && capability.canWrite;
  const showDecisionActions = writeReady && !closed;
  const approveDisabled = stale || expired || decisionPending;

  return (
    <section className="zhs-proposal-review" aria-labelledby={titleId}>
      <header className="zhs-proposal-review__header">
        <div className="zhs-proposal-review__identity">
          <p className="zhs-proposal-review__eyebrow">Proposal review</p>
          <h1 id={titleId}>
            <Anchor href={hrefFor({ kind: "file", stash, path: proposal.path })}>
              <PathText value={proposal.path} />
            </Anchor>
          </h1>
          {proposal.message ? (
            <p className="zhs-proposal-review__message">{proposal.message}</p>
          ) : null}
        </div>
        <dl className="zhs-proposal-review__facts">
          <div>
            <dt>Base</dt>
            <dd>{baseLabel(proposal.baseVersion)}</dd>
          </div>
          <div>
            <dt>Head</dt>
            <dd>{headLabel(current, approvedVersion)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <ProposalStatusBadge status={proposal.status} />
            </dd>
          </div>
        </dl>
      </header>

      {stale && current !== null && !closed ? (
        <Notice className="zhs-proposal-review__stale" variant="warning">
          <strong>
            Head moved to v{current.version} by {current.author || "unknown author"} — this proposal
            was written against {staleBaseLabel(proposal.baseVersion)}; approving would refuse
          </strong>
        </Notice>
      ) : null}

      {expired ? (
        <Notice className="zhs-proposal-review__expired" variant="warning">
          <strong>This proposal has expired. Approval is disabled.</strong>
          <p>It may still be rejected to record a decision reason.</p>
        </Notice>
      ) : null}

      {decisionError !== null ? (
        <div className="zhs-proposal-review__decision-error">
          <ErrorBanner
            error={decisionError}
            onRetry={() => void refreshProposal()}
            title="Could not refresh the proposal decision"
          />
        </div>
      ) : null}

      <section className="zhs-proposal-review__diff" aria-labelledby={diffTitleId}>
        <div className="zhs-proposal-review__toolbar">
          <div>
            <h2 id={diffTitleId}>Base → candidate</h2>
            <p>This diff is immutable even when the file head moves.</p>
          </div>
          <DiffControls
            isNarrow={preferences.isNarrow}
            marks={preferences.marks}
            preferredLayout={preferences.preferredLayout}
            setMarks={preferences.setMarks}
            setPreferredLayout={preferences.setPreferredLayout}
            setWrap={preferences.setWrap}
            wrap={preferences.wrap}
          />
        </div>
        <div className="zhs-proposal-review__diff-pane">
          {model !== null ? (
            <DiffPane
              fromLabel={
                proposal.baseVersion === null ? "empty base" : `base v${proposal.baseVersion}`
              }
              layout={preferences.effectiveLayout}
              marks={preferences.marks}
              model={model}
              toLabel="candidate"
              wrap={preferences.wrap}
            />
          ) : diff.state === "oversized" ? (
            <Notice variant="warning">The proposal diff is too large to preview.</Notice>
          ) : (
            <Notice>No line changes between the immutable base and candidate.</Notice>
          )}
        </div>
      </section>

      <DecisionRecord proposal={proposal} stash={stash} />

      {showDecisionActions ? (
        <footer className="zhs-proposal-review__actions">
          <Button
            disabled={approveDisabled}
            title={
              stale
                ? "Approval is disabled because the head moved"
                : expired
                  ? "Approval is disabled because the proposal expired"
                  : undefined
            }
            variant="primary"
            onClick={() => setDialog("approve")}
          >
            Approve…
          </Button>
          <Button disabled={decisionPending} variant="danger" onClick={() => setDialog("reject")}>
            Reject…
          </Button>
        </footer>
      ) : null}

      <ApproveProposalDialog
        open={dialog === "approve"}
        proposal={proposal}
        stash={stash}
        onApproved={handleApproved}
        onClose={() => setDialog(null)}
        onClosed={handleClosed}
        onExpired={handleExpired}
        onStale={handleStale}
      />
      <RejectProposalDialog
        open={dialog === "reject"}
        proposal={proposal}
        stash={stash}
        onClose={() => setDialog(null)}
        onClosed={handleClosed}
        onRejected={handleRejected}
      />
    </section>
  );
}

export function ProposalReview(props: ProposalReviewProps) {
  return (
    <ProposalReviewForTarget key={JSON.stringify([props.stash, props.proposalId])} {...props} />
  );
}
