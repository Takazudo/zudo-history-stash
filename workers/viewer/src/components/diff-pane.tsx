import "../../../../packages/ui/src/styles/primitives.css";
import "../../../../packages/ui/src/styles/stateful.css";
// Keep Viewer page-level diff layout styles until #99 installs the package stylesheet globally.
import "./diff-table.css";

export {
  DiffPane,
  type DiffPaneLayout,
  type DiffPaneProps,
} from "../../../../packages/ui/src/components/relocated.js";
