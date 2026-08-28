export type ProposalListStatus = "open" | "all";

export interface ProposalListHrefOptions {
  status?: ProposalListStatus;
  path?: string;
}

export const PROPOSAL_CREATED_FLASH = "proposal-created" as const;
export const PROPOSAL_CREATED_FLASH_MESSAGE = "Proposal saved and ready for review.";

export interface ProposalCreatedLocationState {
  proposalFlash: typeof PROPOSAL_CREATED_FLASH;
}

export function proposalListHref(
  stash: string,
  { status = "open", path }: ProposalListHrefOptions = {},
): string {
  const href = `/s/${encodeURIComponent(stash)}/proposals`;
  const query = new URLSearchParams();
  if (status === "all") query.set("status", status);
  if (path !== undefined && path.length > 0) query.set("path", path);
  const serialized = query.toString();
  return serialized.length === 0 ? href : `${href}?${serialized}`;
}

export function proposalListStatusFrom(searchParams: URLSearchParams): ProposalListStatus {
  return searchParams.get("status") === "all" ? "all" : "open";
}

export function proposalCreatedLocationState(): ProposalCreatedLocationState {
  return { proposalFlash: PROPOSAL_CREATED_FLASH };
}

export function hasProposalCreatedFlash(state: unknown): state is ProposalCreatedLocationState {
  return Boolean(
    state &&
    typeof state === "object" &&
    "proposalFlash" in state &&
    state.proposalFlash === PROPOSAL_CREATED_FLASH,
  );
}

export function stateWithoutProposalFlash(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("proposalFlash" in state)) {
    return state;
  }
  const next = { ...(state as Record<string, unknown>) };
  delete next.proposalFlash;
  return Object.keys(next).length === 0 ? null : next;
}
