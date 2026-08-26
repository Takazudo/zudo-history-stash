import type { FileRecord, VersionRecord } from "@takazudo/zudo-history-stash";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { WorkbenchComparison } from "../hooks/use-workbench.js";
import { Button } from "../primitives/button.js";
import { SrOnly } from "../primitives/sr-only.js";
import { KindBadge } from "./kind-badge.js";
import { RelativeTime } from "./relative-time.js";

export interface HistoryRailProps {
  versions: readonly VersionRecord[];
  source: Pick<FileRecord, "version"> | null;
  comparison: WorkbenchComparison | Pick<FileRecord, "version"> | null;
  head: Pick<FileRecord, "version"> | null;
  onLoadSource: (version: number) => void;
  onSetComparison: (comparison: WorkbenchComparison) => void;
  onEditFrom: (version: number) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
}

function newestFirst(versions: readonly VersionRecord[]): VersionRecord[] {
  return [...versions].sort((left, right) => right.version - left.version);
}

function historyControl(event: KeyboardEvent<HTMLElement>): HTMLButtonElement | null {
  const target = event.target;
  return target instanceof Element
    ? target.closest<HTMLButtonElement>("button[data-history-control]")
    : null;
}

/** Compact A/B history selector with an independently controlled seam collapse. */
export function HistoryRail({
  versions,
  source,
  comparison,
  head,
  onLoadSource,
  onSetComparison,
  onEditFrom,
  open,
  defaultOpen = true,
  onOpenChange,
  id,
}: HistoryRailProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const railOpen = open ?? internalOpen;
  const ordered = newestFirst(versions);
  const comparisonVersion =
    comparison === "head"
      ? head?.version
      : typeof comparison === "number"
        ? comparison
        : comparison?.version;
  const panelId = id ?? `zhs-history-rail-${generatedId}`;

  function setOpen(next: boolean): void {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }

  function handleKeyboard(event: KeyboardEvent<HTMLElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const current = historyControl(event);
    const slot = current?.dataset.historyControl;
    if (current === null || (slot !== "source" && slot !== "comparison")) return;
    const controls = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        `button[data-history-control="${slot}"]`,
      ) ?? [],
    );
    const currentIndex = controls.indexOf(current);
    if (currentIndex < 0 || controls.length === 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, controls.length - 1);
    if (event.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = controls.length - 1;
    event.preventDefault();
    controls[nextIndex]?.focus();
  }

  return (
    <aside
      aria-label="Version history"
      className="zhs-history-rail"
      data-rail={railOpen ? "open" : "closed"}
    >
      <div
        ref={panelRef}
        className="zhs-history-rail__panel"
        hidden={!railOpen}
        id={panelId}
        onKeyDown={handleKeyboard}
      >
        <div className="zhs-history-rail__heading">
          <strong>History — {ordered.length} versions</strong>
          <span>A is the editor source. B is the draft comparison.</span>
        </div>
        <div className="zhs-history-rail__list">
          {ordered.map((version) => {
            const isHead = head?.version === version.version;
            const isSource = source?.version === version.version;
            const isComparison = comparisonVersion === version.version;
            return (
              <div
                aria-current={isSource ? "true" : undefined}
                className="zhs-history-rail__row"
                data-history-version={version.version}
                key={version.version}
              >
                <div className="zhs-history-rail__slots">
                  <button
                    aria-label={`Use v${version.version} as source A`}
                    aria-pressed={isSource}
                    className="zhs-history-rail__slot"
                    data-history-control="source"
                    type="button"
                    onClick={() => onLoadSource(version.version)}
                  >
                    <span aria-hidden="true">A</span>
                  </button>
                  <button
                    aria-label={`Use v${version.version} as comparison B`}
                    aria-pressed={isComparison}
                    className="zhs-history-rail__slot zhs-history-rail__slot--comparison"
                    data-history-control="comparison"
                    type="button"
                    onClick={() => onSetComparison(isHead ? "head" : version.version)}
                  >
                    <span aria-hidden="true">B</span>
                  </button>
                </div>
                <div className="zhs-history-rail__metadata">
                  <div className="zhs-history-rail__summary">
                    <span className="zhs-history-rail__version">v{version.version}</span>
                    {isHead ? <span className="zhs-history-rail__head">head</span> : null}
                    <span className="zhs-history-rail__message">
                      {version.message || "No message"}
                    </span>
                  </div>
                  <div className="zhs-history-rail__details">
                    <KindBadge kind={version.kind} rollbackOf={version.rollbackOf} />
                    <span>{version.author || "Unknown author"}</span>
                    <RelativeTime value={version.createdAt} />
                  </div>
                </div>
                <Button
                  aria-label={`Edit from v${version.version}`}
                  size="sm"
                  variant="ghost"
                  onClick={() => onEditFrom(version.version)}
                >
                  Edit from
                </Button>
              </div>
            );
          })}
        </div>
      </div>
      <button
        aria-controls={panelId}
        aria-expanded={railOpen}
        aria-label={railOpen ? "Collapse version history" : "Expand version history"}
        className="zhs-history-rail__toggle"
        type="button"
        onClick={() => setOpen(!railOpen)}
      >
        <span
          aria-hidden="true"
          className="zhs-history-rail__chevron"
          data-direction={railOpen ? "collapse" : "expand"}
        />
        <SrOnly>{railOpen ? "Collapse" : "Expand"}</SrOnly>
      </button>
    </aside>
  );
}
