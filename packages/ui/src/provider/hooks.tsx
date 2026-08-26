import type { StashClient } from "@takazudo/zudo-history-stash";
import { useStashUiContext } from "./context.js";
import type {
  CanWriteState,
  IsAdminState,
  StashAnchorProps,
  StashHrefFor,
  StashMeState,
} from "./types.js";

export function useStashClient(): StashClient {
  return useStashUiContext().client;
}

export function useStashClientForSignal(): (signal: AbortSignal) => StashClient {
  return useStashUiContext().clientForSignal;
}

export function useStashHref(): StashHrefFor {
  return useStashUiContext().hrefFor;
}

export function Anchor(props: StashAnchorProps) {
  const AnchorComponent = useStashUiContext().Anchor;
  return <AnchorComponent {...props} />;
}

export function useMe(): StashMeState {
  return useStashUiContext().me;
}

export function useCanWrite(stash: string): CanWriteState {
  const state = useMe();
  const canWrite =
    state.ready &&
    state.me !== null &&
    (state.me.principal === "admin" ||
      (state.me.principal === "stash" && state.me.stash === stash && state.me.scope === "write"));
  return { ready: state.ready, canWrite };
}

export function useIsAdmin(): IsAdminState {
  const state = useMe();
  return {
    ready: state.ready,
    isAdmin: state.ready && state.me?.principal === "admin",
  };
}
