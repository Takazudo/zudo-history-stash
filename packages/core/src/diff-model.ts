import { diffChars, diffWordsWithSpace } from "diff";
import type { Change } from "diff";
import type { DiffHunk, DiffStats } from "./diff.js";
import { DIFF_MAX_INTRALINE_CHARS, DIFF_MAX_INTRALINE_LENGTH } from "./limits.js";

export type DiffSegmentKind = "same" | "added" | "removed";

export interface DiffSegment {
  kind: DiffSegmentKind;
  text: string;
}

export interface DiffCell {
  lineNumber: number;
  text: string;
  segments: DiffSegment[];
  noNewline?: true;
}

export type DiffModelRow =
  | {
      kind: "hunk";
      header: string;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }
  | { kind: "context"; left: DiffCell; right: DiffCell }
  | { kind: "removed"; left: DiffCell; right: null }
  | { kind: "added"; left: null; right: DiffCell }
  | { kind: "changed-pair"; left: DiffCell; right: DiffCell }
  | { kind: "marker"; text: string; side: "old" | "new" | "both" };

export type DiffUnifiedRow =
  | { kind: "hunk"; header: string }
  | { kind: "marker"; text: string; side: "old" | "new" | "both" }
  | {
      kind: "context" | "removed" | "added";
      oldLine: number | null;
      newLine: number | null;
      segments: DiffSegment[];
      noNewline?: true;
    };

export interface DiffModel {
  rows: DiffModelRow[];
  unified: DiffUnifiedRow[];
  stats: DiffStats;
  crlf: { old: boolean; new: boolean };
  intralineSkipped: number;
}

export interface DiffModelOptions {
  intraline?: boolean;
  maxIntralineLength?: number;
  maxIntralineChars?: number;
}

type DiffSide = "old" | "new" | "both";
type ParsedLineKind = "context" | "removed" | "added";

interface ParsedLine {
  type: "line";
  kind: ParsedLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewlineOld: boolean;
  noNewlineNew: boolean;
}

interface ParsedMarker {
  type: "marker";
  text: string;
  side: DiffSide;
}

type ParsedItem = ParsedLine | ParsedMarker;

interface IntralineState {
  enabled: boolean;
  maxLength: number;
  maxChars: number;
  submittedChars: number;
  skipped: number;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const CJK_PATTERN = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u8c48-\ufaff\uff00-\uffef]/u;

function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function sideForPrefix(prefix: string | undefined): DiffSide | null {
  if (prefix === "-") return "old";
  if (prefix === "+") return "new";
  if (prefix === " ") return "both";
  return null;
}

function markerSide(lines: readonly string[], index: number): DiffSide {
  let before: DiffSide | null = null;
  let after: DiffSide | null = null;

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (lines[cursor] === NO_NEWLINE_MARKER) continue;
    const side = sideForPrefix(lines[cursor]?.[0]);
    if (side !== null) {
      before = side;
      break;
    }
  }

  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor] === NO_NEWLINE_MARKER) continue;
    const side = sideForPrefix(lines[cursor]?.[0]);
    if (side !== null) {
      after = side;
      break;
    }
  }

  if (before === null) return after ?? "both";
  if (after === null) return before;
  return before === after ? before : "both";
}

function displayText(rawText: string): { text: string; crlf: boolean } {
  if (!rawText.endsWith("\r")) return { text: rawText, crlf: false };
  return { text: rawText.slice(0, -1), crlf: true };
}

function recordCrlf(crlf: { old: boolean; new: boolean }, side: DiffSide): void {
  if (side !== "new") crlf.old = true;
  if (side !== "old") crlf.new = true;
}

function parseHunk(hunk: DiffHunk, crlf: { old: boolean; new: boolean }): ParsedItem[] {
  const parsed: ParsedItem[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let previousLine: ParsedLine | null = null;

  for (const [index, rawLine] of hunk.lines.entries()) {
    if (rawLine === NO_NEWLINE_MARKER) {
      if (previousLine !== null) {
        if (previousLine.kind !== "added") previousLine.noNewlineOld = true;
        if (previousLine.kind !== "removed") previousLine.noNewlineNew = true;
      }
      previousLine = null;
      continue;
    }

    const prefix = rawLine[0];
    const normalized = displayText(rawLine.slice(1));

    if (prefix === "-") {
      const line: ParsedLine = {
        type: "line",
        kind: "removed",
        oldLine,
        newLine: null,
        text: normalized.text,
        noNewlineOld: false,
        noNewlineNew: false,
      };
      parsed.push(line);
      previousLine = line;
      oldLine += 1;
      if (normalized.crlf) recordCrlf(crlf, "old");
      continue;
    }

    if (prefix === "+") {
      const line: ParsedLine = {
        type: "line",
        kind: "added",
        oldLine: null,
        newLine,
        text: normalized.text,
        noNewlineOld: false,
        noNewlineNew: false,
      };
      parsed.push(line);
      previousLine = line;
      newLine += 1;
      if (normalized.crlf) recordCrlf(crlf, "new");
      continue;
    }

    if (prefix === " ") {
      const line: ParsedLine = {
        type: "line",
        kind: "context",
        oldLine,
        newLine,
        text: normalized.text,
        noNewlineOld: false,
        noNewlineNew: false,
      };
      parsed.push(line);
      previousLine = line;
      oldLine += 1;
      newLine += 1;
      if (normalized.crlf) recordCrlf(crlf, "both");
      continue;
    }

    const side = markerSide(hunk.lines, index);
    const marker = displayText(rawLine);
    if (marker.crlf) recordCrlf(crlf, side);
    parsed.push({
      type: "marker",
      text: marker.text,
      side,
    });
    previousLine = null;
  }

  return parsed;
}

function sameSegments(text: string): DiffSegment[] {
  return [{ kind: "same", text }];
}

function toCell(line: ParsedLine, side: "old" | "new", segments: DiffSegment[]): DiffCell {
  const lineNumber = side === "old" ? line.oldLine : line.newLine;
  if (lineNumber === null) throw new Error(`Missing ${side} line number`);

  const cell: DiffCell = { lineNumber, text: line.text, segments };
  const noNewline = side === "old" ? line.noNewlineOld : line.noNewlineNew;
  if (noNewline) cell.noNewline = true;
  return cell;
}

function toSegments(changes: readonly Change[], side: "old" | "new"): DiffSegment[] {
  const segments: DiffSegment[] = [];

  for (const change of changes) {
    if ((side === "old" && change.added === true) || (side === "new" && change.removed === true)) {
      continue;
    }

    const kind: DiffSegmentKind =
      change.added === true ? "added" : change.removed === true ? "removed" : "same";
    if (change.value.length > 0) segments.push({ kind, text: change.value });
  }

  return segments;
}

function pairSegments(
  oldText: string,
  newText: string,
  state: IntralineState,
): { left: DiffSegment[]; right: DiffSegment[] } {
  if (!state.enabled) {
    return { left: sameSegments(oldText), right: sameSegments(newText) };
  }

  const pairChars = oldText.length + newText.length;
  if (
    oldText.length > state.maxLength ||
    newText.length > state.maxLength ||
    state.submittedChars + pairChars > state.maxChars
  ) {
    state.skipped += 1;
    return { left: sameSegments(oldText), right: sameSegments(newText) };
  }

  state.submittedChars += pairChars;
  const useChars =
    CJK_PATTERN.test(oldText) ||
    CJK_PATTERN.test(newText) ||
    !/\s/u.test(oldText) ||
    !/\s/u.test(newText);
  const changes = useChars ? diffChars(oldText, newText) : diffWordsWithSpace(oldText, newText);
  return { left: toSegments(changes, "old"), right: toSegments(changes, "new") };
}

function appendChangedRun(
  rows: DiffModelRow[],
  removed: readonly ParsedLine[],
  added: readonly ParsedLine[],
  intraline: IntralineState,
): void {
  const pairCount = Math.min(removed.length, added.length);

  for (let index = 0; index < pairCount; index += 1) {
    const oldLine = removed[index];
    const newLine = added[index];
    if (oldLine === undefined || newLine === undefined) continue;
    const segments = pairSegments(oldLine.text, newLine.text, intraline);
    rows.push({
      kind: "changed-pair",
      left: toCell(oldLine, "old", segments.left),
      right: toCell(newLine, "new", segments.right),
    });
  }

  for (const line of removed.slice(pairCount)) {
    rows.push({
      kind: "removed",
      left: toCell(line, "old", sameSegments(line.text)),
      right: null,
    });
  }

  for (const line of added.slice(pairCount)) {
    rows.push({
      kind: "added",
      left: null,
      right: toCell(line, "new", sameSegments(line.text)),
    });
  }
}

function appendHunkRows(
  rows: DiffModelRow[],
  parsed: readonly ParsedItem[],
  intraline: IntralineState,
): void {
  let index = 0;

  while (index < parsed.length) {
    const item = parsed[index];
    if (item === undefined) break;

    if (item.type === "marker") {
      rows.push({ kind: "marker", text: item.text, side: item.side });
      index += 1;
      continue;
    }

    if (item.kind === "context") {
      rows.push({
        kind: "context",
        left: toCell(item, "old", sameSegments(item.text)),
        right: toCell(item, "new", sameSegments(item.text)),
      });
      index += 1;
      continue;
    }

    if (item.kind === "added") {
      rows.push({
        kind: "added",
        left: null,
        right: toCell(item, "new", sameSegments(item.text)),
      });
      index += 1;
      continue;
    }

    const removed: ParsedLine[] = [];
    while (index < parsed.length) {
      const candidate = parsed[index];
      if (candidate?.type !== "line" || candidate.kind !== "removed") break;
      removed.push(candidate);
      index += 1;
    }

    const added: ParsedLine[] = [];
    while (index < parsed.length) {
      const candidate = parsed[index];
      if (candidate?.type !== "line" || candidate.kind !== "added") break;
      added.push(candidate);
      index += 1;
    }

    appendChangedRun(rows, removed, added, intraline);
  }
}

function unifiedRow(
  kind: "context" | "removed" | "added",
  oldLine: number | null,
  newLine: number | null,
  cell: DiffCell,
): DiffUnifiedRow {
  const row: DiffUnifiedRow = { kind, oldLine, newLine, segments: cell.segments };
  if (cell.noNewline === true) row.noNewline = true;
  return row;
}

function deriveUnified(rows: readonly DiffModelRow[]): DiffUnifiedRow[] {
  const unified: DiffUnifiedRow[] = [];

  for (const row of rows) {
    if (row.kind === "hunk") {
      unified.push({ kind: "hunk", header: row.header });
    } else if (row.kind === "marker") {
      unified.push({ kind: "marker", text: row.text, side: row.side });
    } else if (row.kind === "context") {
      unified.push(unifiedRow("context", row.left.lineNumber, row.right.lineNumber, row.left));
    } else if (row.kind === "removed") {
      unified.push(unifiedRow("removed", row.left.lineNumber, null, row.left));
    } else if (row.kind === "added") {
      unified.push(unifiedRow("added", null, row.right.lineNumber, row.right));
    } else {
      unified.push(unifiedRow("removed", row.left.lineNumber, null, row.left));
      unified.push(unifiedRow("added", null, row.right.lineNumber, row.right));
    }
  }

  return unified;
}

function computeStats(hunks: readonly DiffHunk[]): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0 };
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) stats.added += 1;
      if (line.startsWith("-")) stats.removed += 1;
    }
  }
  return stats;
}

export function buildDiffModel(
  hunks: readonly DiffHunk[],
  options: DiffModelOptions = {},
): DiffModel {
  const rows: DiffModelRow[] = [];
  const crlf = { old: false, new: false };
  const intraline: IntralineState = {
    enabled: options.intraline !== false,
    maxLength: options.maxIntralineLength ?? DIFF_MAX_INTRALINE_LENGTH,
    maxChars: options.maxIntralineChars ?? DIFF_MAX_INTRALINE_CHARS,
    submittedChars: 0,
    skipped: 0,
  };

  for (const hunk of hunks) {
    rows.push({
      kind: "hunk",
      header: hunkHeader(hunk),
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
    });
    appendHunkRows(rows, parseHunk(hunk, crlf), intraline);
  }

  return {
    rows,
    unified: deriveUnified(rows),
    stats: computeStats(hunks),
    crlf,
    intralineSkipped: intraline.skipped,
  };
}
