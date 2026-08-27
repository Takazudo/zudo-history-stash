import type { ApiError, MeResponse } from "@takazudo/zudo-history-stash-core";
import { useEffect, useState } from "react";
import { useStashClient, type ViewerStashClient } from "./stash-client-provider.js";

export type MeState =
  | { status: "idle" | "loading"; me: null; error: null }
  | { status: "ready"; me: MeResponse; error: null }
  | { status: "error"; me: null; error: ApiError };

interface MeSnapshot {
  client: ViewerStashClient | null;
  state: MeState;
}

const IDLE_ME_STATE: MeState = { status: "idle", me: null, error: null };

export function useMe(): MeState {
  const { client } = useStashClient();
  const [snapshot, setSnapshot] = useState<MeSnapshot>(() => ({
    client,
    state: IDLE_ME_STATE,
  }));
  // A replacement credential must never inherit the previous principal for even one render.
  const state = snapshot.client === client ? snapshot.state : IDLE_ME_STATE;

  useEffect(() => {
    if (!client) {
      setSnapshot({ client, state: IDLE_ME_STATE });
      return;
    }

    const controller = new AbortController();
    setSnapshot({ client, state: { status: "loading", me: null, error: null } });
    void client.me({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSnapshot({
        client,
        state: result.ok
          ? { status: "ready", me: result.value, error: null }
          : { status: "error", me: null, error: result.error },
      });
    });

    return () => controller.abort();
  }, [client]);

  return state;
}
