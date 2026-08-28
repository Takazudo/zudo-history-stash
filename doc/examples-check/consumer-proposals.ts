import {
  createStashClient,
  isProposalClosedResult,
  isProposalExpiredResult,
  isProposalStaleResult,
  type ClientResult,
} from "@takazudo/zudo-history-stash";

function valueOf<T>(result: ClientResult<T>, step: string): T {
  if (!result.ok) {
    throw new Error(`${step} failed: ${result.error.code}`);
  }
  return result.value;
}

export async function proposeAndApprove(input: {
  baseUrl: string;
  writeToken: string;
  stash: string;
  path: string;
  body: string;
  baseVersion: number | null;
  stableIdempotencyKey: string;
}) {
  const client = createStashClient({ baseUrl: input.baseUrl, token: input.writeToken });
  const proposals = client.proposals(input.stash);
  const proposal = valueOf(
    await proposals.create(
      {
        path: input.path,
        body: input.body,
        baseVersion: input.baseVersion,
        message: "Candidate content",
      },
      { idempotencyKey: input.stableIdempotencyKey },
    ),
    "create proposal",
  );
  const diff = valueOf(await proposals.diff(proposal.id), "diff proposal");
  const approval = await proposals.approve(proposal.id, { message: "Approved" });

  if (isProposalStaleResult(approval)) {
    return { kind: "stale" as const, current: approval.current, proposal, diff };
  }
  if (isProposalExpiredResult(approval)) {
    return { kind: "expired" as const, proposal, diff };
  }
  if (isProposalClosedResult(approval)) {
    return { kind: "closed" as const, proposal, diff };
  }
  if (!approval.ok) {
    return { kind: "failed" as const, failure: approval, proposal, diff };
  }
  return { kind: "applied" as const, value: approval.value, proposal, diff };
}
