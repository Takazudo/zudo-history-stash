import { formatPatch, structuredPatch } from "diff";
import { DIFF_MAX_BYTES, DIFF_MAX_EDIT_LENGTH, DIFF_TIMEOUT_MS } from "./limits.js";

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffStats {
  added: number;
  removed: number;
}

export type DiffResult =
  | { state: "same" }
  | { state: "binary" }
  | { state: "oversized"; reason: "bytes" | "complexity" }
  | { state: "ready"; unified: string; truncated: boolean; hunks: DiffHunk[]; stats: DiffStats };

export interface ComputeDiffOptions {
  fromText: string;
  toText: string;
  fromLabel: string;
  toLabel: string;
  context?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxEditLength?: number;
  maxUnifiedBytes?: number;
}

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateAtLineBoundary(
  unified: string,
  maxUnifiedBytes: number | undefined,
): { unified: string; truncated: boolean } {
  if (maxUnifiedBytes === undefined || utf8Length(unified) <= maxUnifiedBytes) {
    return { unified, truncated: false };
  }

  let cursor = 0;
  let keptBytes = 0;
  let kept = "";

  while (cursor < unified.length) {
    const newline = unified.indexOf("\n", cursor);
    if (newline === -1) break;

    const line = unified.slice(cursor, newline + 1);
    const lineBytes = utf8Length(line);
    if (keptBytes + lineBytes > maxUnifiedBytes) break;

    kept += line;
    keptBytes += lineBytes;
    cursor = newline + 1;
  }

  return { unified: kept, truncated: true };
}

export function computeDiff({
  fromText,
  toText,
  fromLabel,
  toLabel,
  context = 3,
  maxBytes = DIFF_MAX_BYTES,
  timeoutMs = DIFF_TIMEOUT_MS,
  maxEditLength = DIFF_MAX_EDIT_LENGTH,
  maxUnifiedBytes,
}: ComputeDiffOptions): DiffResult {
  if (fromText === toText) return { state: "same" };

  if (utf8Length(fromText) > maxBytes || utf8Length(toText) > maxBytes) {
    return { state: "oversized", reason: "bytes" };
  }

  const patch = structuredPatch(fromLabel, toLabel, fromText, toText, undefined, undefined, {
    context,
    timeout: timeoutMs,
    maxEditLength,
  });

  if (patch === undefined) return { state: "oversized", reason: "complexity" };

  const stats = patch.hunks.reduce<DiffStats>(
    (total, hunk) => {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) total.added += 1;
        if (line.startsWith("-")) total.removed += 1;
      }
      return total;
    },
    { added: 0, removed: 0 },
  );
  const formatted = truncateAtLineBoundary(formatPatch(patch), maxUnifiedBytes);

  return {
    state: "ready",
    unified: formatted.unified,
    truncated: formatted.truncated,
    hunks: patch.hunks,
    stats,
  };
}
