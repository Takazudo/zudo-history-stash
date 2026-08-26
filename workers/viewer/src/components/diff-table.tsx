import { useMemo } from "react";
import type { DiffHunk } from "@takazudo/zudo-history-stash";
import { buildDiffModel } from "@takazudo/zudo-history-stash-core";
import { DiffPane } from "./diff-pane.js";

export function DiffTable({ hunks, wrap }: { hunks: DiffHunk[]; wrap: boolean }) {
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
