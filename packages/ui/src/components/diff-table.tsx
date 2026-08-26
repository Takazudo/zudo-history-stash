import type { DiffHunk } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { useMemo } from "react";
import { DiffPane } from "./diff-pane.js";

export interface DiffTableProps {
  hunks: DiffHunk[];
  wrap: boolean;
}

export function DiffTable({ hunks, wrap }: DiffTableProps) {
  const model = useMemo(() => buildDiffModel(hunks), [hunks]);
  return (
    <DiffPane
      fromLabel="Old"
      layout="unified"
      marks={true}
      model={model}
      toLabel="New"
      wrap={wrap}
    />
  );
}
