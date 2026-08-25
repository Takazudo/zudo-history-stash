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
  | { state: "oversized"; reason: "bytes" | "complexity" }
  | { state: "ready"; unified: string; truncated: boolean; hunks: DiffHunk[]; stats: DiffStats };

export interface ComputeDiffOptions {
  path: string;
  fromLabel: string;
  toLabel: string;
  context?: number;
  maxUnifiedBytes?: number;
}

export function computeDiff(_from: string, _to: string, _options: ComputeDiffOptions): DiffResult {
  throw new Error("not-implemented");
}
