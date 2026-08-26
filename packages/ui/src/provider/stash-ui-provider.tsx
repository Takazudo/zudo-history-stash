import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
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

interface MeRequest {
  client: StashClient;
  promise: ReturnType<StashClient["me"]>;
}

function DefaultAnchor({ children, ...props }: StashAnchorProps) {
  return <a {...props}>{children}</a>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unable to load the current principal");
}

function requestMe(client: StashClient): ReturnType<StashClient["me"]> {
  try {
    return client.me();
  } catch (error: unknown) {
    return Promise.reject(error);
  }
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
  const meRequestRef = useRef<MeRequest | null>(null);
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

    const cachedRequest = meRequestRef.current;
    const request =
      cachedRequest?.client === client
        ? cachedRequest
        : ({ client, promise: requestMe(client) } satisfies MeRequest);
    meRequestRef.current = request;

    void request.promise.then(
      (result) => {
        if (!active || meRequestRef.current !== request) return;
        setMeSnapshot({
          client,
          state: result.ok
            ? { ready: true, me: result.value, error: null }
            : { ready: true, me: null, error: result.error },
        });
      },
      (error: unknown) => {
        if (active && meRequestRef.current === request) {
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
