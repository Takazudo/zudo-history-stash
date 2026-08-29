import { useAsync, type AsyncState } from "./use-async.js";
import { clientValue } from "../components/error-banner.js";
import { useStashClientForSignal } from "../provider/hooks.js";

export type OpenChangeSetCountState = AsyncState<number>;

/** Reads only one row; the server's total is the authoritative open review count. */
export function useOpenChangeSetCount(stash: string): OpenChangeSetCountState {
  const clientForSignal = useStashClientForSignal();
  return useAsync(
    async (signal) => {
      const page = await clientValue(
        clientForSignal(signal).changeSets(stash).list({ status: "open", limit: 1 }),
      );
      return page.total;
    },
    [clientForSignal, stash],
  );
}
