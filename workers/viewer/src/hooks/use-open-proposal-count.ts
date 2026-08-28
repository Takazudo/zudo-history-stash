import { useMemo } from "react";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { clientValue } from "../components/error-banner.js";
import { useAsync, type AsyncState } from "./use-async.js";

interface CountTarget {
  client: ViewerStashClient | null;
  stash: string | undefined;
  path: string | undefined;
}

interface CountValue {
  target: CountTarget;
  total: number | null;
}

interface CountFailure {
  target: CountTarget;
  error: unknown;
}

function isCountFailure(value: unknown): value is CountFailure {
  return Boolean(value && typeof value === "object" && "target" in value && "error" in value);
}

/** Auxiliary open-proposal total, fenced across stash, path, and credential identity changes. */
export function useOpenProposalCount(
  client: ViewerStashClient | null,
  stash: string | undefined,
  path?: string,
): AsyncState<number | null> {
  const target = useMemo<CountTarget>(() => ({ client, stash, path }), [client, path, stash]);
  const result = useAsync<CountValue>(
    async (signal) => {
      if (target.client === null || target.stash === undefined) return { target, total: null };
      try {
        const page = await clientValue(
          target.client
            .withSignal(signal)
            .proposals(target.stash)
            .list({
              status: "open",
              limit: 1,
              ...(target.path === undefined ? {} : { path: target.path }),
            }),
        );
        return { target, total: page.total };
      } catch (error: unknown) {
        throw { target, error } satisfies CountFailure;
      }
    },
    [target],
  );

  if (result.state === "ready" && result.value.target === target) {
    return { state: "ready", value: result.value.total, reload: result.reload };
  }
  if (result.state === "error" && isCountFailure(result.error) && result.error.target === target) {
    return { state: "error", error: result.error.error, reload: result.reload };
  }
  return { state: "loading", reload: result.reload };
}
