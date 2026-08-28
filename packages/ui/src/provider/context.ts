import { createContext, useContext } from "react";
import type { StashClient } from "@takazudo/zudo-history-stash";
import type { StashAnchorComponent, StashHrefFor, StashMeState } from "./types.js";

export interface StashUiContextValue {
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  hrefFor: StashHrefFor;
  Anchor: StashAnchorComponent;
  me: StashMeState;
}

export const StashUiContext = createContext<StashUiContextValue | null>(null);

export function useStashUiContext(): StashUiContextValue {
  const value = useContext(StashUiContext);
  if (value === null) {
    throw new Error("History Stash UI hooks must be used within StashUiProvider");
  }
  return value;
}
