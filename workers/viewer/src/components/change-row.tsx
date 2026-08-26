import {
  ChangeRow as RelocatedChangeRow,
  type ChangeRowProps,
} from "../../../../packages/ui/src/components/relocated.js";
import { ViewerAnchor } from "./relocated-link-bridge.js";

export type ViewerChangeRowProps = Omit<ChangeRowProps, "Anchor" | "hrefFor">;

/** Keep current Viewer call sites router-aware until #99 installs the package provider bridge. */
export function ChangeRow(props: ViewerChangeRowProps) {
  return <RelocatedChangeRow {...props} Anchor={ViewerAnchor} />;
}
