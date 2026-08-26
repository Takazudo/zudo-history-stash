import { Fragment } from "react";
import type { DiffModel, DiffUnifiedRow } from "@takazudo/zudo-history-stash-core";
import { DiffCellSegments, SplitDiffTable } from "./split-diff-table.js";
import "./diff-table.css";

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
    <tr className={`diff-table__row diff-table__row--${kind}`} data-line-type={kind}>
      <td
        aria-label={row.oldLine === null ? "No old line" : `Old line ${row.oldLine}`}
        className="diff-table__gutter"
        data-column="old"
      >
        {row.oldLine ?? ""}
      </td>
      <td
        aria-label={row.newLine === null ? "No new line" : `New line ${row.newLine}`}
        className="diff-table__gutter"
        data-column="new"
      >
        {row.newLine ?? ""}
      </td>
      <td
        aria-label={signLabel}
        className="diff-table__sign"
        data-column="sign"
        data-diff-sign={kind === "context" ? " " : sign}
      >
        {sign}
      </td>
      <td className="diff-table__content" data-column="content">
        <DiffCellSegments segments={row.segments} />
      </td>
    </tr>
  );
}

function MarkerRow({ text }: { text: string }) {
  return (
    <tr className="diff-table__marker">
      <td colSpan={4}>{text}</td>
    </tr>
  );
}

function UnifiedRows({ rows }: { rows: readonly DiffUnifiedRow[] }) {
  let hunkIndex = -1;

  return rows.map((row, rowIndex) => {
    if (row.kind === "hunk") {
      hunkIndex += 1;
      const currentHunkIndex = hunkIndex;
      return (
        <tr
          className="diff-table__hunk"
          data-hunk-index={currentHunkIndex}
          id={`diff-hunk-${currentHunkIndex}`}
          key={`hunk-${rowIndex}`}
        >
          <th colSpan={4} scope="rowgroup">
            {row.header}
          </th>
        </tr>
      );
    }

    if (row.kind === "marker") {
      return <MarkerRow key={`marker-${rowIndex}`} text={row.text} />;
    }

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
    "diff-table-pane",
    `diff-table-pane--${wrap ? "wrap" : "nowrap"}`,
    marks ? null : "diff-table-pane--no-marks",
  ]
    .filter((className): className is string => className !== null)
    .join(" ");

  return (
    <div className={paneClasses} data-wrap={wrap ? "on" : "off"}>
      {layout === "split" ? (
        <SplitDiffTable fromLabel={fromLabel} rows={model.rows} toLabel={toLabel} />
      ) : (
        <table className="diff-table diff-table--unified" aria-label="Unified diff">
          <thead>
            <tr>
              <th className="diff-table__gutter" scope="col">
                {fromLabel}
              </th>
              <th className="diff-table__gutter" scope="col">
                {toLabel}
              </th>
              <th className="diff-table__sign" scope="col">
                Change
              </th>
              <th className="diff-table__content" scope="col">
                Content
              </th>
            </tr>
          </thead>
          <tbody>
            <UnifiedRows rows={model.unified} />
          </tbody>
        </table>
      )}
    </div>
  );
}
