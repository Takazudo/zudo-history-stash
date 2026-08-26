import type { DiffModel, DiffUnifiedRow } from "@takazudo/zudo-history-stash-core";
import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { DiffCellSegments, SplitDiffTable } from "./split-diff-table.js";

export type DiffPaneLayout = "unified" | "split";

export interface DiffPaneProps {
  model: DiffModel;
  layout: DiffPaneLayout;
  marks: boolean;
  wrap: boolean;
  fromLabel: string;
  toLabel: string;
}

type DiffCodeRow = Extract<DiffUnifiedRow, { kind: "context" | "removed" | "added" }>;
type DisplayLineKind = "add" | "remove" | "context";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function displayLineKind(kind: DiffCodeRow["kind"]): DisplayLineKind {
  if (kind === "added") return "add";
  if (kind === "removed") return "remove";
  return "context";
}

function UnifiedCodeRow({ row }: { row: DiffCodeRow }) {
  const kind = displayLineKind(row.kind);
  const sign = kind === "add" ? "+" : kind === "remove" ? "−" : "\u00a0";
  const signLabel =
    kind === "add" ? "Added line" : kind === "remove" ? "Removed line" : "Unchanged line";

  return (
    <TableRow className={`zhs-diff-table__row zhs-diff-table__row--${kind}`} data-line-type={kind}>
      <TableCell
        aria-label={row.oldLine === null ? "No old line" : `Old line ${row.oldLine}`}
        className="zhs-diff-table__gutter"
        data-column="old"
      >
        {row.oldLine ?? ""}
      </TableCell>
      <TableCell
        aria-label={row.newLine === null ? "No new line" : `New line ${row.newLine}`}
        className="zhs-diff-table__gutter"
        data-column="new"
      >
        {row.newLine ?? ""}
      </TableCell>
      <TableCell
        aria-label={signLabel}
        className="zhs-diff-table__sign"
        data-column="sign"
        data-diff-sign={kind === "context" ? " " : sign}
      >
        {sign}
      </TableCell>
      <TableCell className="zhs-diff-table__content" data-column="content">
        <DiffCellSegments segments={row.segments} />
      </TableCell>
    </TableRow>
  );
}

function MarkerRow({ text }: { text: string }) {
  return (
    <TableRow className="zhs-diff-table__marker">
      <TableCell colSpan={4}>{text}</TableCell>
    </TableRow>
  );
}

function UnifiedRows({ rows }: { rows: readonly DiffUnifiedRow[] }) {
  let hunkIndex = -1;
  return rows.map((row, rowIndex) => {
    if (row.kind === "hunk") {
      hunkIndex += 1;
      return (
        <TableRow
          className="zhs-diff-table__hunk"
          data-hunk-index={hunkIndex}
          id={`diff-hunk-${hunkIndex}`}
          key={`hunk-${rowIndex}`}
        >
          <TableHeader colSpan={4} scope="rowgroup">
            {row.header}
          </TableHeader>
        </TableRow>
      );
    }
    if (row.kind === "marker") return <MarkerRow key={`marker-${rowIndex}`} text={row.text} />;
    return (
      <Fragment key={`line-${rowIndex}`}>
        <UnifiedCodeRow row={row} />
        {row.noNewline === true ? <MarkerRow text={NO_NEWLINE_MARKER} /> : null}
      </Fragment>
    );
  });
}

export function DiffPane({ model, layout, marks, wrap, fromLabel, toLabel }: DiffPaneProps) {
  const paneClasses = [
    "zhs-diff-table-pane",
    `zhs-diff-table-pane--${wrap ? "wrap" : "nowrap"}`,
    marks ? null : "zhs-diff-table-pane--no-marks",
  ]
    .filter((className): className is string => className !== null)
    .join(" ");

  return (
    <div className={paneClasses} data-wrap={wrap ? "on" : "off"}>
      {layout === "split" ? (
        <SplitDiffTable fromLabel={fromLabel} rows={model.rows} toLabel={toLabel} />
      ) : (
        <Table className="zhs-diff-table zhs-diff-table--unified" aria-label="Unified diff">
          <TableHead>
            <TableRow>
              <TableHeader className="zhs-diff-table__gutter" scope="col">
                {fromLabel}
              </TableHeader>
              <TableHeader className="zhs-diff-table__gutter" scope="col">
                {toLabel}
              </TableHeader>
              <TableHeader className="zhs-diff-table__sign" scope="col">
                Change
              </TableHeader>
              <TableHeader className="zhs-diff-table__content" scope="col">
                Content
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            <UnifiedRows rows={model.unified} />
          </TableBody>
        </Table>
      )}
    </div>
  );
}
