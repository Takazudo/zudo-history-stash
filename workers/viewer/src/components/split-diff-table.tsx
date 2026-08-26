import { Fragment } from "react";
import type { DiffCell, DiffModelRow, DiffSegment } from "@takazudo/zudo-history-stash-core";

export interface SplitDiffTableProps {
  rows: readonly DiffModelRow[];
  fromLabel: string;
  toLabel: string;
}

type SplitLineRow = Exclude<DiffModelRow, { kind: "hunk" | "marker" }>;
type SplitSide = "left" | "right";
type SplitCellRole = "context" | "removed" | "added";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

const SIGN: Record<SplitCellRole, string> = {
  context: " ",
  removed: "−",
  added: "+",
};

const SIGN_LABEL: Record<SplitCellRole, string> = {
  context: "Unchanged line",
  removed: "Removed line",
  added: "Added line",
};

export function DiffCellSegments({ segments }: { segments: readonly DiffSegment[] }) {
  const hasChange = segments.some((segment) => segment.kind !== "same");

  return (
    <>
      {/* Keep exact full-line text lookup compatible without duplicating screen-reader speech. */}
      {hasChange ? (
        <span aria-hidden="true" hidden>
          {segments.map((segment) => segment.text).join("")}
        </span>
      ) : null}
      {segments.map((segment, segmentIndex) => {
        const key = `${segment.kind}-${segmentIndex}`;

        if (segment.kind === "added") {
          return (
            <ins className="diff-mark diff-mark--added" key={key}>
              <span className="sr-only">added text: </span>
              {segment.text}
              <span className="sr-only"> end of change</span>
            </ins>
          );
        }

        if (segment.kind === "removed") {
          return (
            <del className="diff-mark diff-mark--removed" key={key}>
              <span className="sr-only">removed text: </span>
              {segment.text}
              <span className="sr-only"> end of change</span>
            </del>
          );
        }

        return <Fragment key={key}>{segment.text}</Fragment>;
      })}
    </>
  );
}

function SplitCell({
  cell,
  role,
  side,
}: {
  cell: DiffCell | null;
  role: SplitCellRole;
  side: SplitSide;
}) {
  const version = side === "left" ? "old" : "new";
  const versionLabel = side === "left" ? "Old" : "New";

  if (cell === null) {
    const voidLabel = side === "left" ? "No old line" : "No new line";

    return (
      <>
        <td className="diff-table__gutter diff-table__cell--void" data-column={`${version}-line`} />
        <td className="diff-table__sign diff-table__cell--void" data-column={`${version}-change`} />
        <td
          aria-label={voidLabel}
          className="diff-table__content diff-table__cell--void"
          data-column={`${version}-text`}
          data-testid={`split-${side}-void`}
        />
      </>
    );
  }

  return (
    <>
      <td
        aria-label={`${versionLabel} line ${cell.lineNumber}`}
        className={`diff-table__gutter diff-table__cell--${role}`}
        data-column={`${version}-line`}
      >
        {cell.lineNumber}
      </td>
      <td
        aria-label={SIGN_LABEL[role]}
        className={`diff-table__sign diff-table__cell--${role}`}
        data-column={`${version}-change`}
        data-diff-sign={SIGN[role]}
      >
        {SIGN[role]}
      </td>
      <td
        className={`diff-table__content diff-table__cell--${role}`}
        data-column={`${version}-text`}
        data-testid={`split-${side}-${role}`}
      >
        <DiffCellSegments segments={cell.segments} />
      </td>
    </>
  );
}

function SplitCodeRow({ row }: { row: SplitLineRow }) {
  if (row.kind === "context") {
    return (
      <tr className="diff-table__row diff-table__row--context" data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="context" side="left" />
        <td className="diff-table__divider" />
        <SplitCell cell={row.right} role="context" side="right" />
      </tr>
    );
  }

  if (row.kind === "changed-pair") {
    return (
      <tr className="diff-table__row diff-table__row--changed-pair" data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="removed" side="left" />
        <td className="diff-table__divider" />
        <SplitCell cell={row.right} role="added" side="right" />
      </tr>
    );
  }

  if (row.kind === "removed") {
    return (
      <tr className="diff-table__row diff-table__row--removed" data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="removed" side="left" />
        <td className="diff-table__divider" />
        <SplitCell cell={row.right} role="added" side="right" />
      </tr>
    );
  }

  return (
    <tr className="diff-table__row diff-table__row--added" data-row-kind={row.kind}>
      <SplitCell cell={row.left} role="removed" side="left" />
      <td className="diff-table__divider" />
      <SplitCell cell={row.right} role="added" side="right" />
    </tr>
  );
}

function SideMarker({ old, new: newSide }: { old: string | null; new: string | null }) {
  const side = old !== null && newSide !== null ? "both" : old !== null ? "old" : "new";

  return (
    <span className="diff-table__side-marker" data-marker-side={side}>
      <span className="diff-table__side-marker-old">{old}</span>
      <span className="diff-table__side-marker-new">{newSide}</span>
    </span>
  );
}

function NoNewlineMarkerRow({ row }: { row: SplitLineRow }) {
  const old = row.left?.noNewline === true ? NO_NEWLINE_MARKER : null;
  const newSide = row.right?.noNewline === true ? NO_NEWLINE_MARKER : null;
  if (old === null && newSide === null) return null;

  return (
    <tr className="diff-table__marker" data-row-kind="no-newline">
      <td colSpan={7}>
        <SideMarker new={newSide} old={old} />
      </td>
    </tr>
  );
}

function SourceMarkerRow({ row }: { row: Extract<DiffModelRow, { kind: "marker" }> }) {
  return (
    <tr className="diff-table__marker" data-marker-side={row.side} data-row-kind={row.kind}>
      <td colSpan={7}>
        {row.side === "both" ? (
          row.text
        ) : (
          <SideMarker
            new={row.side === "new" ? row.text : null}
            old={row.side === "old" ? row.text : null}
          />
        )}
      </td>
    </tr>
  );
}

function SplitRows({ rows }: { rows: readonly DiffModelRow[] }) {
  let hunkIndex = -1;

  return rows.map((row, rowIndex) => {
    if (row.kind === "hunk") {
      hunkIndex += 1;
      const currentHunkIndex = hunkIndex;
      return (
        <tr
          className="diff-table__hunk"
          data-hunk-index={currentHunkIndex}
          data-row-kind={row.kind}
          id={`diff-split-hunk-${currentHunkIndex}`}
          key={`hunk-${rowIndex}`}
        >
          <th colSpan={7} scope="rowgroup">
            {row.header}
          </th>
        </tr>
      );
    }

    if (row.kind === "marker") {
      return <SourceMarkerRow key={`marker-${rowIndex}`} row={row} />;
    }

    return (
      <Fragment key={`line-${rowIndex}`}>
        <SplitCodeRow row={row} />
        <NoNewlineMarkerRow row={row} />
      </Fragment>
    );
  });
}

export function SplitDiffTable({ rows, fromLabel, toLabel }: SplitDiffTableProps) {
  return (
    <table aria-label="Split diff" className="diff-table diff-table--split">
      <caption className="diff-table__caption">
        <span className="diff-table__caption-content">
          <span>{fromLabel}</span>
          <span aria-hidden="true">→</span>
          <span>{toLabel}</span>
        </span>
      </caption>
      <colgroup>
        <col className="diff-table__col--gutter" style={{ width: "5ch" }} />
        <col className="diff-table__col--sign" style={{ width: "2.5ch" }} />
        <col />
        <col className="diff-table__col--divider" style={{ width: 0 }} />
        <col className="diff-table__col--gutter" style={{ width: "5ch" }} />
        <col className="diff-table__col--sign" style={{ width: "2.5ch" }} />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th
            aria-label="Old line"
            className="diff-table__column-heading diff-table__column-heading--line"
            scope="col"
          >
            Line
          </th>
          <th
            aria-label="Old change"
            className="diff-table__column-heading diff-table__column-heading--sign"
            scope="col"
          >
            Δ
          </th>
          <th aria-label="Old text" className="diff-table__column-heading" scope="col">
            Text
          </th>
          <th className="diff-table__divider" scope="col">
            <span className="sr-only">Divider</span>
          </th>
          <th
            aria-label="New line"
            className="diff-table__column-heading diff-table__column-heading--line"
            scope="col"
          >
            Line
          </th>
          <th
            aria-label="New change"
            className="diff-table__column-heading diff-table__column-heading--sign"
            scope="col"
          >
            Δ
          </th>
          <th aria-label="New text" className="diff-table__column-heading" scope="col">
            Text
          </th>
        </tr>
      </thead>
      <tbody>
        <SplitRows rows={rows} />
      </tbody>
    </table>
  );
}
