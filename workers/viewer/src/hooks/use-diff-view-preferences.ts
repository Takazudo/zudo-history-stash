import { useCallback, useState } from "react";
import { useMediaQuery } from "./use-media-query.js";

export type DiffViewLayout = "unified" | "split";

export interface DiffViewPreferences {
  preferredLayout: DiffViewLayout;
  effectiveLayout: DiffViewLayout;
  isNarrow: boolean;
  marks: boolean;
  wrap: boolean;
  setPreferredLayout: (layout: DiffViewLayout) => void;
  setMarks: (marks: boolean) => void;
  setWrap: (wrap: boolean) => void;
}

const LAYOUT_STORAGE_KEY = "zhs.diff.layout";
const MARKS_STORAGE_KEY = "zhs.diff.marks";
const WRAP_STORAGE_KEY = "zhs.diff.wrap";
const NARROW_DIFF_QUERY = "(max-width: 56rem)";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readLayout(): DiffViewLayout {
  const stored = readStorage(LAYOUT_STORAGE_KEY);
  return stored === "split" || stored === "unified" ? stored : "unified";
}

function readBoolean(key: string): boolean {
  const stored = readStorage(key);
  if (stored === "false") return false;
  return true;
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep the visible preference usable when storage is unavailable.
  }
}

export function useDiffViewPreferences(): DiffViewPreferences {
  const [preferredLayout, setPreferredLayoutState] = useState<DiffViewLayout>(readLayout);
  const [marks, setMarksState] = useState(() => readBoolean(MARKS_STORAGE_KEY));
  const [wrap, setWrapState] = useState(() => readBoolean(WRAP_STORAGE_KEY));
  const isNarrow = useMediaQuery(NARROW_DIFF_QUERY);

  const setPreferredLayout = useCallback((layout: DiffViewLayout) => {
    setPreferredLayoutState(layout);
    writeStorage(LAYOUT_STORAGE_KEY, layout);
  }, []);

  const setMarks = useCallback((nextMarks: boolean) => {
    setMarksState(nextMarks);
    writeStorage(MARKS_STORAGE_KEY, String(nextMarks));
  }, []);

  const setWrap = useCallback((nextWrap: boolean) => {
    setWrapState(nextWrap);
    writeStorage(WRAP_STORAGE_KEY, String(nextWrap));
  }, []);

  return {
    preferredLayout,
    effectiveLayout: isNarrow ? "unified" : preferredLayout,
    isNarrow,
    marks,
    wrap,
    setPreferredLayout,
    setMarks,
    setWrap,
  };
}
