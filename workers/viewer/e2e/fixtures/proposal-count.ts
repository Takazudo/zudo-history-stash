import type { Route } from "@playwright/test";

interface OpenProposalCountTarget {
  stash: string;
  path?: string;
}

function countRequestTarget({ stash, path }: OpenProposalCountTarget): string {
  const query = new URLSearchParams([
    ["status", "open"],
    ...(path === undefined ? [] : [["path", path]]),
    ["limit", "1"],
  ]).toString();
  return `/api/v1/stashes/${encodeURIComponent(stash)}/proposals?${query}`;
}

/** Fulfills only the exact auxiliary open-proposal count requests owned by a mock page. */
export async function fulfillEmptyOpenProposalCount(
  route: Route,
  targets: readonly OpenProposalCountTarget[],
): Promise<boolean> {
  const request = route.request();
  if (request.method() !== "GET") return false;
  const url = new URL(request.url());
  const target = `${url.pathname}${url.search}`;
  if (!targets.some((candidate) => countRequestTarget(candidate) === target)) return false;

  await route.fulfill({
    status: 200,
    json: { proposals: [], nextAfter: null, total: 0 },
  });
  return true;
}
