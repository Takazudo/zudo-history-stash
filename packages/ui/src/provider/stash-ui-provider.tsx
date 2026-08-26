import { useCallback, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { StashClient } from "@takazudo/zudo-history-stash";
import { StashUiContext } from "./context.js";
import { defaultStashHrefFor } from "./routes.js";
import type {
  StashAnchorComponent,
  StashAnchorProps,
  StashHrefFor,
  StashMeState,
} from "./types.js";

const INITIAL_ME_STATE: StashMeState = { ready: false, me: null, error: null };

interface MeSnapshot {
  client: StashClient;
  state: StashMeState;
}

function DefaultAnchor({ children, ...props }: StashAnchorProps) {
  return <a {...props}>{children}</a>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unable to load the current principal");
}

export interface StashUiProviderProps extends PropsWithChildren {
  client: StashClient;
  clientForSignal?: (signal: AbortSignal) => StashClient;
  hrefFor?: StashHrefFor;
  Anchor?: StashAnchorComponent;
}

export function StashUiProvider({
  client,
  clientForSignal,
  hrefFor = defaultStashHrefFor,
  Anchor = DefaultAnchor,
  children,
}: StashUiProviderProps) {
  const [meSnapshot, setMeSnapshot] = useState<MeSnapshot>(() => ({
    client,
    state: INITIAL_ME_STATE,
  }));
  // A new client represents a new credential boundary. Deny capabilities during that render,
  // before the passive effect below has a chance to reset and reload the principal.
  const me = meSnapshot.client === client ? meSnapshot.state : INITIAL_ME_STATE;

  useEffect(() => {
    let active = true;
    setMeSnapshot((current) =>
      current.client === client && current.state === INITIAL_ME_STATE
        ? current
        : { client, state: INITIAL_ME_STATE },
    );

    void client.me().then(
      (result) => {
        if (!active) return;
        setMeSnapshot({
          client,
          state: result.ok
            ? { ready: true, me: result.value, error: null }
            : { ready: true, me: null, error: result.error },
        });
      },
      (error: unknown) => {
        if (active) {
          setMeSnapshot({
            client,
            state: { ready: true, me: null, error: asError(error) },
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [client]);

  const getClientForSignal = useCallback(
    (signal: AbortSignal) => clientForSignal?.(signal) ?? client,
    [client, clientForSignal],
  );

  const value = useMemo(
    () => ({ client, clientForSignal: getClientForSignal, hrefFor, Anchor, me }),
    [Anchor, client, getClientForSignal, hrefFor, me],
  );

  return <StashUiContext value={value}>{children}</StashUiContext>;
}
