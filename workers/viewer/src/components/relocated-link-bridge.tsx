import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";

interface ViewerAnchorProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  children?: ReactNode;
}

/** Temporary router adapter until #99 mounts StashUiProvider around the Viewer. */
export function ViewerAnchor({ href, ...props }: ViewerAnchorProps) {
  return <Link {...props} to={href} />;
}
