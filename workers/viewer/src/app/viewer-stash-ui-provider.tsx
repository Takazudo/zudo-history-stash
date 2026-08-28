import {
  StashUiProvider,
  defaultStashHrefFor,
  type StashAnchorProps,
  type StashHrefFor,
} from "@takazudo/zudo-history-stash-ui";
import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStashClient } from "./auth/stash-client-provider.js";

export const viewerHrefFor: StashHrefFor = defaultStashHrefFor;

export function ViewerAnchor({ href, ...props }: StashAnchorProps) {
  return <Link {...props} to={href} />;
}

export function ViewerStashUiProvider({ children }: { children: ReactNode }) {
  const { client } = useStashClient();
  const clientForSignal = useCallback(
    (signal: AbortSignal) => {
      if (!client) throw new Error("The Viewer client is not authenticated");
      return client.withSignal(signal);
    },
    [client],
  );

  if (!client) return null;

  return (
    <StashUiProvider
      Anchor={ViewerAnchor}
      client={client}
      clientForSignal={clientForSignal}
      hrefFor={viewerHrefFor}
    >
      {children}
    </StashUiProvider>
  );
}
