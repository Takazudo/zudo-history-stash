import type { ApiError, MeResponse } from "@takazudo/zudo-history-stash-core";
import { useEffect, useState } from "react";
import { useStashClient } from "./stash-client-provider.js";

export type MeState =
  | { status: "idle" | "loading"; me: null; error: null }
  | { status: "ready"; me: MeResponse; error: null }
  | { status: "error"; me: null; error: ApiError };

export function useMe(): MeState {
  const { client } = useStashClient();
  const [state, setState] = useState<MeState>({ status: "idle", me: null, error: null });

  useEffect(() => {
    if (!client) {
      setState({ status: "idle", me: null, error: null });
      return;
    }

    const controller = new AbortController();
    setState({ status: "loading", me: null, error: null });
    void client.me({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setState(
        result.ok
          ? { status: "ready", me: result.value, error: null }
          : { status: "error", me: null, error: result.error },
      );
    });

    return () => controller.abort();
  }, [client]);

  return state;
}
