import type { StashClient } from "@takazudo/zudo-history-stash";
import {
  StashUiProvider,
  type StashAnchorProps,
  type StashHrefFor,
} from "@takazudo/zudo-history-stash-ui";
import type { ReactNode } from "react";

function Anchor({ href, ...props }: StashAnchorProps) {
  return <a href={href} {...props} />;
}

export function ReferenceUiProvider({
  children,
  client,
  clientForSignal,
  hrefFor,
}: {
  children: ReactNode;
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  hrefFor: StashHrefFor;
}) {
  return (
    <StashUiProvider
      Anchor={Anchor}
      client={client}
      clientForSignal={clientForSignal}
      hrefFor={hrefFor}
    >
      {children}
    </StashUiProvider>
  );
}
