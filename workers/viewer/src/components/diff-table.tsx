import type { DiffHunk } from "@takazudo/zudo-history-stash";
import "./diff-table.css";

type DiffLineKind = "add" | "remove" | "context";

interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

function hunkLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function lineDetails(
  line: string,
  oldLine: number,
  newLine: number,
): { line: DiffLine; nextOldLine: number; nextNewLine: number } | null {
  const prefix = line[0];
  const content = line.slice(1);

  if (prefix === "+") {
    return {
      line: { kind: "add", oldLine: null, newLine, content },
      nextOldLine: oldLine,
      nextNewLine: newLine + 1,
    };
  }
  if (prefix === "-") {
    return {
      line: { kind: "remove", oldLine, newLine: null, content },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine,
    };
  }
  if (prefix === " ") {
    return {
      line: { kind: "context", oldLine, newLine, content },
      nextOldLine: oldLine + 1,
      nextNewLine: newLine + 1,
    };
  }
  return null;
}

function DiffCodeRow({ line }: { line: DiffLine }) {
  const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : "\u00a0";
  const signLabel =
    line.kind === "add" ? "Added line" : line.kind === "remove" ? "Removed line" : "Unchanged line";

  return (
    <tr className={`diff-table__row diff-table__row--${line.kind}`} data-line-type={line.kind}>
      <td
        aria-label={line.oldLine === null ? "No old line" : `Old line ${line.oldLine}`}
        className="diff-table__gutter"
        data-column="old"
      >
        {line.oldLine ?? ""}
      </td>
      <td
        aria-label={line.newLine === null ? "No new line" : `New line ${line.newLine}`}
        className="diff-table__gutter"
        data-column="new"
      >
        {line.newLine ?? ""}
      </td>
      <td
        aria-label={signLabel}
        className="diff-table__sign"
        data-column="sign"
        data-diff-sign={line.kind === "context" ? " " : sign}
      >
        {sign}
      </td>
      <td className="diff-table__content" data-column="content">
        {line.content}
      </td>
    </tr>
  );
}

function DiffHunkRows({ hunk, hunkIndex }: { hunk: DiffHunk; hunkIndex: number }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return (
    <>
      <tr className="diff-table__hunk" data-hunk-index={hunkIndex} id={`diff-hunk-${hunkIndex}`}>
        <th colSpan={4} scope="rowgroup">
          {hunkLabel(hunk)}
        </th>
      </tr>
      {hunk.lines.map((rawLine, lineIndex) => {
        if (rawLine.startsWith("\\")) {
          return (
            <tr className="diff-table__marker" key={`${hunkIndex}-marker-${lineIndex}`}>
              <td colSpan={4}>{rawLine}</td>
            </tr>
          );
        }

        const details = lineDetails(rawLine, oldLine, newLine);
        if (details === null) {
          return (
            <tr className="diff-table__marker" key={`${hunkIndex}-unknown-${lineIndex}`}>
              <td colSpan={4}>{rawLine}</td>
            </tr>
          );
        }
        oldLine = details.nextOldLine;
        newLine = details.nextNewLine;
        return <DiffCodeRow key={`${hunkIndex}-${lineIndex}`} line={details.line} />;
      })}
    </>
  );
}

export function DiffTable({ hunks, wrap }: { hunks: DiffHunk[]; wrap: boolean }) {
  return (
    <div
      className={`diff-table-pane diff-table-pane--${wrap ? "wrap" : "nowrap"}`}
      data-wrap={wrap ? "on" : "off"}
    >
      <table className="diff-table" aria-label="Unified diff">
        <thead>
          <tr>
            <th className="diff-table__gutter" scope="col">
              Old
            </th>
            <th className="diff-table__gutter" scope="col">
              New
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
          {hunks.map((hunk, hunkIndex) => (
            <DiffHunkRows hunk={hunk} hunkIndex={hunkIndex} key={hunkIndex} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
