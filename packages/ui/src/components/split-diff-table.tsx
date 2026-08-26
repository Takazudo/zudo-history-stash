import type { DiffCell, DiffModelRow, DiffSegment } from "@takazudo/zudo-history-stash-core";
import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { SrOnly } from "../primitives/sr-only.js";

export interface SplitDiffTableProps {
  rows: readonly DiffModelRow[];
  fromLabel: string;
  toLabel: string;
}

type SplitLineRow = Exclude<DiffModelRow, { kind: "hunk" | "marker" }>;
type SplitSide = "left" | "right";
type SplitCellRole = "context" | "removed" | "added";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

const SIGN: Record<SplitCellRole, string> = { context: " ", removed: "−", added: "+" };
const SIGN_LABEL: Record<SplitCellRole, string> = {
  context: "Unchanged line",
  removed: "Removed line",
  added: "Added line",
};

export function DiffCellSegments({ segments }: { segments: readonly DiffSegment[] }) {
  const hasChange = segments.some((segment) => segment.kind !== "same");
  return (
    <>
      {hasChange ? (
        <span aria-hidden="true" hidden>
          {segments.map((segment) => segment.text).join("")}
        </span>
      ) : null}
      {segments.map((segment, segmentIndex) => {
        const key = `${segment.kind}-${segmentIndex}`;
        if (segment.kind === "added") {
          return (
            <ins className="zhs-diff-mark zhs-diff-mark--added" key={key}>
              <SrOnly>added text: </SrOnly>
              {segment.text}
              <SrOnly> end of change</SrOnly>
            </ins>
          );
        }
        if (segment.kind === "removed") {
          return (
            <del className="zhs-diff-mark zhs-diff-mark--removed" key={key}>
              <SrOnly>removed text: </SrOnly>
              {segment.text}
              <SrOnly> end of change</SrOnly>
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
        <TableCell
          className="zhs-diff-table__gutter zhs-diff-table__cell--void"
          data-column={`${version}-line`}
        />
        <TableCell
          className="zhs-diff-table__sign zhs-diff-table__cell--void"
          data-column={`${version}-change`}
        />
        <TableCell
          aria-label={voidLabel}
          className="zhs-diff-table__content zhs-diff-table__cell--void"
          data-column={`${version}-text`}
          data-testid={`split-${side}-void`}
        />
      </>
    );
  }
  return (
    <>
      <TableCell
        aria-label={`${versionLabel} line ${cell.lineNumber}`}
        className={`zhs-diff-table__gutter zhs-diff-table__cell--${role}`}
        data-column={`${version}-line`}
      >
        {cell.lineNumber}
      </TableCell>
      <TableCell
        aria-label={SIGN_LABEL[role]}
        className={`zhs-diff-table__sign zhs-diff-table__cell--${role}`}
        data-column={`${version}-change`}
        data-diff-sign={SIGN[role]}
      >
        {SIGN[role]}
      </TableCell>
      <TableCell
        className={`zhs-diff-table__content zhs-diff-table__cell--${role}`}
        data-column={`${version}-text`}
        data-testid={`split-${side}-${role}`}
      >
        <DiffCellSegments segments={cell.segments} />
      </TableCell>
    </>
  );
}

function SplitCodeRow({ row }: { row: SplitLineRow }) {
  const rowClass = `zhs-diff-table__row zhs-diff-table__row--${row.kind}`;
  if (row.kind === "context") {
    return (
      <TableRow className={rowClass} data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="context" side="left" />
        <TableCell className="zhs-diff-table__divider" />
        <SplitCell cell={row.right} role="context" side="right" />
      </TableRow>
    );
  }
  if (row.kind === "changed-pair") {
    return (
      <TableRow className={rowClass} data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="removed" side="left" />
        <TableCell className="zhs-diff-table__divider" />
        <SplitCell cell={row.right} role="added" side="right" />
      </TableRow>
    );
  }
  if (row.kind === "removed") {
    return (
      <TableRow className={rowClass} data-row-kind={row.kind}>
        <SplitCell cell={row.left} role="removed" side="left" />
        <TableCell className="zhs-diff-table__divider" />
        <SplitCell cell={row.right} role="added" side="right" />
      </TableRow>
    );
  }
  return (
    <TableRow className={rowClass} data-row-kind={row.kind}>
      <SplitCell cell={row.left} role="removed" side="left" />
      <TableCell className="zhs-diff-table__divider" />
      <SplitCell cell={row.right} role="added" side="right" />
    </TableRow>
  );
}

function SideMarker({ old, new: newSide }: { old: string | null; new: string | null }) {
  const side = old !== null && newSide !== null ? "both" : old !== null ? "old" : "new";
  return (
    <span className="zhs-diff-table__side-marker" data-marker-side={side}>
      <span className="zhs-diff-table__side-marker-old">{old}</span>
      <span className="zhs-diff-table__side-marker-new">{newSide}</span>
    </span>
  );
}

function NoNewlineMarkerRow({ row }: { row: SplitLineRow }) {
  const old = row.left?.noNewline === true ? NO_NEWLINE_MARKER : null;
  const newSide = row.right?.noNewline === true ? NO_NEWLINE_MARKER : null;
  if (old === null && newSide === null) return null;
  return (
    <TableRow className="zhs-diff-table__marker" data-row-kind="no-newline">
      <TableCell colSpan={7}>
        <SideMarker new={newSide} old={old} />
      </TableCell>
    </TableRow>
  );
}

function SourceMarkerRow({ row }: { row: Extract<DiffModelRow, { kind: "marker" }> }) {
  return (
    <TableRow
      className="zhs-diff-table__marker"
      data-marker-side={row.side}
      data-row-kind={row.kind}
    >
      <TableCell colSpan={7}>
        {row.side === "both" ? (
          row.text
        ) : (
          <SideMarker
            new={row.side === "new" ? row.text : null}
            old={row.side === "old" ? row.text : null}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

function SplitRows({ rows }: { rows: readonly DiffModelRow[] }) {
  let hunkIndex = -1;
  return rows.map((row, rowIndex) => {
    if (row.kind === "hunk") {
      hunkIndex += 1;
      return (
        <TableRow
          className="zhs-diff-table__hunk"
          data-hunk-index={hunkIndex}
          data-row-kind={row.kind}
          id={`diff-split-hunk-${hunkIndex}`}
          key={`hunk-${rowIndex}`}
        >
          <TableHeader colSpan={7} scope="rowgroup">
            {row.header}
          </TableHeader>
        </TableRow>
      );
    }
    if (row.kind === "marker") return <SourceMarkerRow key={`marker-${rowIndex}`} row={row} />;
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
    <Table aria-label="Split diff" className="zhs-diff-table zhs-diff-table--split">
      <TableCaption className="zhs-diff-table__caption">
        <span className="zhs-diff-table__caption-content">
          <span>{fromLabel}</span>
          <span aria-hidden="true">→</span>
          <span>{toLabel}</span>
        </span>
      </TableCaption>
      <colgroup>
        <col className="zhs-diff-table__col--gutter" />
        <col className="zhs-diff-table__col--sign" />
        <col />
        <col className="zhs-diff-table__col--divider" />
        <col className="zhs-diff-table__col--gutter" />
        <col className="zhs-diff-table__col--sign" />
        <col />
      </colgroup>
      <TableHead>
        <TableRow>
          <TableHeader
            aria-label="Old line"
            className="zhs-diff-table__column-heading zhs-diff-table__column-heading--line"
            scope="col"
          >
            Line
          </TableHeader>
          <TableHeader
            aria-label="Old change"
            className="zhs-diff-table__column-heading zhs-diff-table__column-heading--sign"
            scope="col"
          >
            Δ
          </TableHeader>
          <TableHeader aria-label="Old text" className="zhs-diff-table__column-heading" scope="col">
            Text
          </TableHeader>
          <TableHeader className="zhs-diff-table__divider" scope="col">
            <SrOnly>Divider</SrOnly>
          </TableHeader>
          <TableHeader
            aria-label="New line"
            className="zhs-diff-table__column-heading zhs-diff-table__column-heading--line"
            scope="col"
          >
            Line
          </TableHeader>
          <TableHeader
            aria-label="New change"
            className="zhs-diff-table__column-heading zhs-diff-table__column-heading--sign"
            scope="col"
          >
            Δ
          </TableHeader>
          <TableHeader aria-label="New text" className="zhs-diff-table__column-heading" scope="col">
            Text
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        <SplitRows rows={rows} />
      </TableBody>
    </Table>
  );
}
