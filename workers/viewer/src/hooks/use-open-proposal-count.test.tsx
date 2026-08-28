import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  ClientResult,
  ProposalListResponse,
  StashProposalsClient,
} from "@takazudo/zudo-history-stash";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { useOpenProposalCount } from "./use-open-proposal-count.js";

function clientWithProposalList(list: StashProposalsClient["list"]) {
  const base = createFakeViewerClient();
  return createFakeViewerClient({
    proposals: (stash) => ({ ...base.proposals(stash), list }),
  });
}

describe("useOpenProposalCount", () => {
  it("requests the exact open, one-row filter with an optional path", async () => {
    const list = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 12 },
    }));
    const client = clientWithProposalList(list);
    const signals: AbortSignal[] = [];
    client.withSignal = (signal) => {
      signals.push(signal);
      return client;
    };

    const { result } = renderHook(() => useOpenProposalCount(client, "notes", "docs/readme.txt"));

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.state === "ready" && result.current.value).toBe(12);
    expect(list).toHaveBeenCalledWith({
      status: "open",
      limit: 1,
      path: "docs/readme.txt",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("render-fences a new credential and ignores the aborted credential's late result", async () => {
    let resolveFirst!: (result: ClientResult<ProposalListResponse>) => void;
    const firstResult = new Promise<ClientResult<ProposalListResponse>>((resolve) => {
      resolveFirst = resolve;
    });
    const firstList = vi.fn(() => firstResult);
    const firstClient = clientWithProposalList(firstList);
    const firstSignals: AbortSignal[] = [];
    firstClient.withSignal = (signal) => {
      firstSignals.push(signal);
      return firstClient;
    };

    const secondList = vi.fn(async (): Promise<ClientResult<ProposalListResponse>> => ({
      ok: true,
      value: { proposals: [], nextAfter: null, total: 3 },
    }));
    const secondClient = clientWithProposalList(secondList);

    const { result, rerender } = renderHook(({ client }) => useOpenProposalCount(client, "notes"), {
      initialProps: { client: firstClient },
    });
    await waitFor(() => expect(firstList).toHaveBeenCalledTimes(1));

    rerender({ client: secondClient });
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.state === "ready" && result.current.value).toBe(3);
    expect(firstSignals[0]?.aborted).toBe(true);

    await act(async () => {
      resolveFirst({
        ok: true,
        value: { proposals: [], nextAfter: null, total: 99 },
      });
      await firstResult;
    });
    expect(result.current.state === "ready" && result.current.value).toBe(3);
  });
});
