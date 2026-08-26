import type { ReactNode } from "react";
import { Anchor as ContextAnchor, useStashHref } from "../provider/hooks.js";
import { defaultStashHrefFor } from "../provider/routes.js";
import type { StashAnchorComponent, StashAnchorProps, StashHrefFor } from "../provider/types.js";

export interface LinkBridgeOverrides {
  Anchor?: StashAnchorComponent;
  hrefFor?: StashHrefFor;
}

interface ResolvedLinkBridge {
  Anchor: StashAnchorComponent;
  hrefFor: StashHrefFor;
}

interface LinkBridgeProps extends LinkBridgeOverrides {
  children: (bridge: ResolvedLinkBridge) => ReactNode;
}

function HtmlAnchor({ children, ...props }: StashAnchorProps) {
  return <a {...props}>{children}</a>;
}

function ProviderLinkBridge({ children }: Pick<LinkBridgeProps, "children">) {
  const hrefFor = useStashHref();
  return children({ Anchor: ContextAnchor, hrefFor });
}

/**
 * Resolve links from StashUiProvider in normal package use. Explicit overrides exist only for
 * host adapters that must bridge a router before they can mount the provider at app level.
 */
export function LinkBridge({ Anchor, hrefFor, children }: LinkBridgeProps) {
  if (Anchor !== undefined || hrefFor !== undefined) {
    return children({
      Anchor: Anchor ?? HtmlAnchor,
      hrefFor: hrefFor ?? defaultStashHrefFor,
    });
  }
  return <ProviderLinkBridge>{children}</ProviderLinkBridge>;
}
