import { useId } from "react";
import { Button } from "../app/shell/button.js";
import type { DiffViewLayout } from "../hooks/use-diff-view-preferences.js";

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
    <div className="diff-view-preferences" aria-label="View preferences" role="group">
      <div className="diff-view-preferences__field">
        <span className="diff-control__label" id={layoutLabelId}>
          Layout
        </span>
        <span className="diff-layout-segment" aria-labelledby={layoutLabelId} role="group">
          <Button
            aria-pressed={preferredLayout === "unified"}
            compact
            onClick={() => setPreferredLayout("unified")}
          >
            Unified
          </Button>
          <Button
            aria-describedby={isNarrow ? splitDescriptionId : undefined}
            aria-pressed={preferredLayout === "split"}
            compact
            disabled={isNarrow}
            onClick={() => setPreferredLayout("split")}
          >
            Split
          </Button>
        </span>
      </div>
      <div className="diff-view-preferences__field">
        <span className="diff-control__label" id={displayLabelId}>
          Display
        </span>
        <span className="diff-display-toggles" aria-labelledby={displayLabelId} role="group">
          <label className="diff-toggle">
            <input
              checked={marks}
              onChange={(event) => setMarks(event.currentTarget.checked)}
              type="checkbox"
            />
            Marks
          </label>
          <label className="diff-toggle">
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
        <span className="sr-only" id={splitDescriptionId}>
          Split view needs a window wider than 56rem
        </span>
      ) : null}
    </div>
  );
}
