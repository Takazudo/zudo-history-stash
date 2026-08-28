import {
  buildDiffModel,
  computeDiff,
  type DiffModel,
  type DiffStats,
} from "@takazudo/zudo-history-stash-core";
import { useEffect, useRef, useState } from "react";

export interface CandidateDiffOptions {
  baseText: string;
  draftText: string;
  context?: number;
}

export interface CandidateDiff {
  model: DiffModel | null;
  stats: DiffStats;
  same: boolean;
  oversized: boolean;
}

interface CandidateDiffCache {
  baseText: string;
  draftText: string;
  context: number;
  value: CandidateDiff;
}

const DEFAULT_CONTEXT = 3;
const DEBOUNCE_MS = 250;

function calculateCandidateDiff(
  baseText: string,
  draftText: string,
  context: number,
): CandidateDiff {
  const result = computeDiff({
    fromText: baseText,
    toText: draftText,
    fromLabel: "base",
    toLabel: "draft",
    context,
  });

  if (result.state === "same") {
    return {
      model: null,
      stats: { added: 0, removed: 0 },
      same: true,
      oversized: false,
    };
  }

  if (result.state === "oversized") {
    return {
      model: null,
      stats: { added: 0, removed: 0 },
      same: false,
      oversized: true,
    };
  }

  return {
    model: buildDiffModel(result.hunks),
    stats: result.stats,
    same: false,
    oversized: false,
  };
}

/** Computes a local candidate diff and debounces subsequent draft changes. */
export function useCandidateDiff({
  baseText,
  draftText,
  context = DEFAULT_CONTEXT,
}: CandidateDiffOptions): CandidateDiff {
  const cacheRef = useRef<CandidateDiffCache | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = {
      baseText,
      draftText,
      context,
      value: calculateCandidateDiff(baseText, draftText, context),
    };
  }

  const [candidate, setCandidate] = useState(cacheRef.current.value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const cached = cacheRef.current;
      if (
        cached !== null &&
        cached.baseText === baseText &&
        cached.draftText === draftText &&
        cached.context === context
      ) {
        return;
      }

      const value = calculateCandidateDiff(baseText, draftText, context);
      cacheRef.current = { baseText, draftText, context, value };
      setCandidate(value);
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [baseText, context, draftText]);

  return candidate;
}
