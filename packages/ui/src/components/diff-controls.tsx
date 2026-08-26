import { useId } from "react";
import type { DiffViewLayout } from "../hooks/use-diff-view-preferences.js";
import { Button } from "../primitives/button.js";
import { SrOnly } from "../primitives/sr-only.js";

export interface DiffControlsProps {
  preferredLayout: DiffViewLayout;
  isNarrow: boolean;
  marks: boolean;
  wrap: boolean;
  setPreferredLayout: (layout: DiffViewLayout) => void;
  setMarks: (marks: boolean) => void;
  setWrap: (wrap: boolean) => void;
}

export function DiffControls({
  preferredLayout,
  isNarrow,
  marks,
  wrap,
  setPreferredLayout,
  setMarks,
  setWrap,
}: DiffControlsProps) {
  const layoutLabelId = useId();
  const displayLabelId = useId();
  const splitDescriptionId = useId();

  return (
    <div className="zhs-diff-view-preferences" aria-label="View preferences" role="group">
      <div className="zhs-diff-view-preferences__field">
        <span className="zhs-diff-control__label" id={layoutLabelId}>
          Layout
        </span>
        <span className="zhs-diff-layout-segment" aria-labelledby={layoutLabelId} role="group">
          <Button
            aria-pressed={preferredLayout === "unified"}
            size="sm"
            onClick={() => setPreferredLayout("unified")}
          >
            Unified
          </Button>
          <Button
            aria-describedby={isNarrow ? splitDescriptionId : undefined}
            aria-pressed={preferredLayout === "split"}
            size="sm"
            disabled={isNarrow}
            onClick={() => setPreferredLayout("split")}
          >
            Split
          </Button>
        </span>
      </div>
      <div className="zhs-diff-view-preferences__field">
        <span className="zhs-diff-control__label" id={displayLabelId}>
          Display
        </span>
        <span className="zhs-diff-display-toggles" aria-labelledby={displayLabelId} role="group">
          <label className="zhs-diff-toggle">
            <input
              checked={marks}
              onChange={(event) => setMarks(event.currentTarget.checked)}
              type="checkbox"
            />
            Marks
          </label>
          <label className="zhs-diff-toggle">
            <input
              checked={wrap}
              onChange={(event) => setWrap(event.currentTarget.checked)}
              type="checkbox"
            />
            Wrap
          </label>
        </span>
      </div>
      {isNarrow ? (
        <SrOnly id={splitDescriptionId}>Split view needs a window wider than 56rem</SrOnly>
      ) : null}
    </div>
  );
}
