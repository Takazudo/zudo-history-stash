import type {
  FileRecord,
  HistoryPage,
  StashClient,
  StashFilesClient,
  VersionRecord,
} from "@takazudo/zudo-history-stash";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clientValue } from "../components/error-banner.js";
import { useStashClient, useStashClientForSignal } from "../provider/hooks.js";
import { useCandidateDiff, type CandidateDiff } from "./use-candidate-diff.js";
import { applyLineEnding, type LineEnding } from "./use-save-machine.js";

const DRAFT_KEY_PREFIX = "zhs.draft.";
const CANDIDATE_SETTLE_MS = 251;
const EMPTY_CANDIDATE: CandidateDiff = {
  model: null,
  stats: { added: 0, removed: 0 },
  same: false,
  oversized: false,
};

export interface WorkbenchDraftRecord {
  sourceVersion: number;
  fenceVersion: number;
  text: string;
  lineEnding: LineEnding;
  savedAt: number;
}

export type WorkbenchComparison = "head" | number;

export type SourceLoadResult =
  | { status: "loaded"; source: FileRecord }
  | { status: "cancelled" }
  | { status: "error"; error: unknown }
  | {
      status: "confirmation-required";
      version: number;
      resolve: (confirmed: boolean) => Promise<SourceLoadResult>;
    };

export interface UseWorkbenchOptions {
  stash: string;
  path: string;
  /** A version supplied by the host's `?from=N` route state. Head is used when omitted. */
  initialSource?: number;
}

export interface WorkbenchState {
  state: "loading" | "ready" | "error";
  error: unknown | null;
  head: FileRecord | null;
  source: FileRecord | null;
  comparison: FileRecord | null;
  comparisonMode: WorkbenchComparison;
  versions: VersionRecord[];
  historyPage: HistoryPage | null;
  historyLoading: boolean;
  historyError: unknown | null;
  sourceLoading: boolean;
  sourceError: unknown | null;
  comparisonLoading: boolean;
  comparisonError: unknown | null;
  draft: string;
  draftRecord: WorkbenchDraftRecord | null;
  draftRestored: boolean;
  draftPersistError: "draft not persisted" | null;
  sourceNotice: string | null;
  lineEnding: LineEnding;
  frozenBody: string;
  dirtyFromSource: boolean;
  displayDiff: CandidateDiff;
  displayDiffPending: boolean;
  sameAsHead: boolean;
  sameAsHeadPending: boolean;
  saveDiff: CandidateDiff;
  saveDiffPending: boolean;
  setDraft: (text: string) => void;
  loadSource: (version: number) => Promise<SourceLoadResult>;
  setComparison: (comparison: WorkbenchComparison) => Promise<boolean>;
  discard: () => void;
  clearForLogout: () => boolean;
  afterSaved: (record: FileRecord) => Promise<boolean>;
  afterStaleReload: (record: FileRecord) => void;
  /** Stable for one client/stash/path target so #98 can refresh without duplicating state. */
  reloadHistory: (signal?: AbortSignal) => Promise<boolean>;
}

interface WorkbenchTarget {
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  stash: string;
  path: string;
  initialSource?: number;
}

interface WorkbenchSnapshot {
  state: "loading" | "ready" | "error";
  error: unknown | null;
  head: FileRecord | null;
  source: FileRecord | null;
  comparison: FileRecord | null;
  comparisonMode: WorkbenchComparison;
  historyPage: HistoryPage | null;
  historyLoading: boolean;
  historyError: unknown | null;
  sourceLoading: boolean;
  sourceError: unknown | null;
  comparisonLoading: boolean;
  comparisonError: unknown | null;
  draft: string;
  draftRecord: WorkbenchDraftRecord | null;
  draftRestored: boolean;
  draftPersistError: "draft not persisted" | null;
  sourceNotice: string | null;
  lineEnding: LineEnding;
}

interface WorkbenchEntry {
  target: WorkbenchTarget;
  snapshot: WorkbenchSnapshot;
}

interface TargetRuntime {
  target: WorkbenchTarget;
  snapshot: WorkbenchSnapshot;
  records: Map<number, FileRecord>;
  initialController: AbortController | null;
  historyController: AbortController | null;
  historyTail: Promise<void>;
  sourceController: AbortController | null;
  comparisonController: AbortController | null;
  initialSequence: number;
  historySequence: number;
  sourceSequence: number;
  sourceIntent: number;
  comparisonSequence: number;
}

interface StoredDraftRead {
  record: WorkbenchDraftRecord | null;
  failed: boolean;
}

interface CandidateIdentity {
  target: WorkbenchTarget;
  baseText: string;
  draftText: string;
}

interface HashEntry {
  target: WorkbenchTarget;
  headHash: string | null;
  body: string;
  same: boolean;
  pending: boolean;
}

function loadingSnapshot(): WorkbenchSnapshot {
  return {
    state: "loading",
    error: null,
    head: null,
    source: null,
    comparison: null,
    comparisonMode: "head",
    historyPage: null,
    historyLoading: true,
    historyError: null,
    sourceLoading: false,
    sourceError: null,
    comparisonLoading: false,
    comparisonError: null,
    draft: "",
    draftRecord: null,
    draftRestored: false,
    draftPersistError: null,
    sourceNotice: null,
    lineEnding: "lf",
  };
}

function createRuntime(target: WorkbenchTarget): TargetRuntime {
  return {
    target,
    snapshot: loadingSnapshot(),
    records: new Map(),
    initialController: null,
    historyController: null,
    historyTail: Promise.resolve(),
    sourceController: null,
    comparisonController: null,
    initialSequence: 0,
    historySequence: 0,
    sourceSequence: 0,
    sourceIntent: 0,
    comparisonSequence: 0,
  };
}

function abortRuntime(runtime: TargetRuntime): void {
  runtime.initialController?.abort();
  runtime.historyController?.abort();
  runtime.sourceController?.abort();
  runtime.comparisonController?.abort();
  runtime.initialSequence += 1;
  runtime.historySequence += 1;
  runtime.sourceSequence += 1;
  runtime.sourceIntent += 1;
  runtime.comparisonSequence += 1;
}

function sameTarget(left: WorkbenchTarget, right: WorkbenchTarget): boolean {
  return (
    left.client === right.client &&
    left.clientForSignal === right.clientForSignal &&
    left.stash === right.stash &&
    left.path === right.path &&
    left.initialSource === right.initialSource
  );
}

function normalizeTextareaText(text: string): string {
  return text.replace(/\r\n?|\n/g, "\n");
}

function bodyText(record: FileRecord | null): string {
  return normalizeTextareaText(record?.body ?? "");
}

export function detectLineEnding(text: string | null): LineEnding {
  return text?.includes("\r\n") ? "crlf" : "lf";
}

function noticeForSource(record: FileRecord): string | null {
  return record.deleted ? `v${record.version} is a deletion; the draft starts empty.` : null;
}

function newestFirst(versions: readonly VersionRecord[]): VersionRecord[] {
  return [...versions].sort((left, right) => right.version - left.version);
}

function normalizeHistory(page: HistoryPage): HistoryPage {
  return { ...page, versions: newestFirst(page.versions) };
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function errorForVersion(version: number): Error {
  return new Error(`Version must be a positive safe integer (received ${String(version)})`);
}

async function readFile(
  files: StashFilesClient,
  path: string,
  version?: number,
): Promise<FileRecord> {
  const result = await files.get(path, version === undefined ? undefined : { version });
  if (!result.ok) throw result;
  if ("notModified" in result) throw new Error("The file representation was not returned");
  if (
    !result.value.deleted &&
    (result.value.contentAccess === "raw" || result.value.body === null)
  ) {
    throw new Error(
      "This file is raw-only and cannot be opened in the text editor. Open the file page to download it.",
    );
  }
  return result.value;
}

async function readStoredSource(
  files: StashFilesClient,
  path: string,
  version: number,
): Promise<FileRecord | null> {
  const result = await files.get(path, { version });
  if (!result.ok) {
    if (result.error.code === "version-not-found") return null;
    throw result;
  }
  if ("notModified" in result) throw new Error("The stored source representation was not returned");
  if (
    !result.value.deleted &&
    (result.value.contentAccess === "raw" || result.value.body === null)
  ) {
    throw new Error(
      "This file is raw-only and cannot be opened in the text editor. Open the file page to download it.",
    );
  }
  return result.value;
}

async function readHead(files: StashFilesClient, path: string): Promise<FileRecord> {
  const result = await files.get(path);
  if (result.ok) {
    if ("notModified" in result) throw new Error("The head representation was not returned");
    if (
      !result.value.deleted &&
      (result.value.contentAccess === "raw" || result.value.body === null)
    ) {
      throw new Error(
        "This file is raw-only and cannot be opened in the text editor. Open the file page to download it.",
      );
    }
    return result.value;
  }
  if (result.error.code === "file-deleted" && result.current !== undefined) {
    return readFile(files, path, result.current.version);
  }
  throw result;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function workbenchDraftKey(stash: string, path: string): string {
  return `${DRAFT_KEY_PREFIX}${stash}.${path}`;
}

function isDraftRecord(value: unknown): value is WorkbenchDraftRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<WorkbenchDraftRecord>;
  return (
    typeof candidate.text === "string" &&
    (candidate.lineEnding === "lf" || candidate.lineEnding === "crlf") &&
    typeof candidate.sourceVersion === "number" &&
    validVersion(candidate.sourceVersion) &&
    typeof candidate.fenceVersion === "number" &&
    validVersion(candidate.fenceVersion) &&
    typeof candidate.savedAt === "number" &&
    Number.isFinite(candidate.savedAt) &&
    candidate.savedAt >= 0
  );
}

function readStoredDraft(stash: string, path: string): StoredDraftRead {
  const storage = sessionStorageOrNull();
  if (storage === null) return { record: null, failed: false };
  const key = workbenchDraftKey(stash, path);
  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return { record: null, failed: false };
    const value: unknown = JSON.parse(serialized);
    if (isDraftRecord(value)) return { record: value, failed: false };
    storage.removeItem(key);
    return { record: null, failed: false };
  } catch {
    return { record: null, failed: true };
  }
}

function storeDraft(stash: string, path: string, record: WorkbenchDraftRecord): boolean {
  const storage = sessionStorageOrNull();
  if (storage === null) return false;
  try {
    storage.setItem(workbenchDraftKey(stash, path), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkbenchDraft(stash: string, path: string): boolean {
  const storage = sessionStorageOrNull();
  if (storage === null) return true;
  try {
    storage.removeItem(workbenchDraftKey(stash, path));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears every persisted workbench draft before the host removes or replaces its credential.
 *
 * A false result means cleanup could not be confirmed, so the host must not install a credential
 * for another principal in this tab.
 */
export function clearWorkbenchDraftsForCredentialChange(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function canRestoreDraft(
  record: WorkbenchDraftRecord,
  source: FileRecord,
  head: FileRecord,
  initialSource: number | undefined,
): boolean {
  return (
    record.sourceVersion === source.version &&
    (initialSource === undefined || initialSource === record.sourceVersion) &&
    record.sourceVersion <= record.fenceVersion &&
    record.fenceVersion <= head.version &&
    record.lineEnding === detectLineEnding(source.body)
  );
}

function useSettledCandidate(
  target: WorkbenchTarget,
  baseText: string,
  draftText: string,
): { value: CandidateDiff; pending: boolean } {
  const candidate = useCandidateDiff({ baseText, draftText });
  const identity = useMemo<CandidateIdentity>(
    () => ({ target, baseText, draftText }),
    [baseText, draftText, target],
  );
  const initialIdentityRef = useRef(identity);
  const [settledIdentity, setSettledIdentity] = useState(initialIdentityRef.current);

  useEffect(() => {
    const timeout = window.setTimeout(() => setSettledIdentity(identity), CANDIDATE_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [identity]);

  const pending = settledIdentity !== identity;
  return { value: pending ? EMPTY_CANDIDATE : candidate, pending };
}

/** Owns source A, comparison B, the current CAS head, and the editor draft independently. */
export function useWorkbench({ stash, path, initialSource }: UseWorkbenchOptions): WorkbenchState {
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const target = useMemo<WorkbenchTarget>(
    () => ({ client, clientForSignal, stash, path, initialSource }),
    [client, clientForSignal, initialSource, path, stash],
  );
  const runtimeRef = useRef<TargetRuntime>(createRuntime(target));
  const mountedRef = useRef(true);
  const [entry, setEntry] = useState<WorkbenchEntry>(() => ({
    target,
    snapshot: runtimeRef.current.snapshot,
  }));
  const snapshot = sameTarget(entry.target, target) ? entry.snapshot : loadingSnapshot();

  const commit = useCallback((runtime: TargetRuntime, next: WorkbenchSnapshot): boolean => {
    if (!mountedRef.current || runtimeRef.current !== runtime) return false;
    runtime.snapshot = next;
    setEntry({ target: runtime.target, snapshot: next });
    return true;
  }, []);

  useLayoutEffect(() => {
    const current = runtimeRef.current;
    if (!sameTarget(current.target, target)) {
      abortRuntime(current);
      const next = createRuntime(target);
      runtimeRef.current = next;
      setEntry({ target, snapshot: next.snapshot });
      return;
    }
    current.snapshot = snapshot;
  }, [snapshot, target]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRuntime(runtimeRef.current);
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!sameTarget(runtime.target, target)) return;
    runtime.initialController?.abort();
    runtime.historyController?.abort();
    runtime.sourceController?.abort();
    runtime.comparisonController?.abort();
    const controller = new AbortController();
    runtime.initialController = controller;
    const sequence = ++runtime.initialSequence;
    const stored = readStoredDraft(stash, path);
    const requestedSource = initialSource ?? stored.record?.sourceVersion;
    const initial = loadingSnapshot();
    if (stored.failed) initial.draftPersistError = "draft not persisted";
    commit(runtime, initial);

    if (requestedSource !== undefined && !validVersion(requestedSource)) {
      const error = errorForVersion(requestedSource);
      commit(runtime, { ...initial, state: "error", error, historyLoading: false });
      return () => controller.abort();
    }

    let signalClient: StashClient;
    try {
      signalClient = clientForSignal(controller.signal);
    } catch (error: unknown) {
      commit(runtime, { ...initial, state: "error", error, historyLoading: false });
      return () => controller.abort();
    }
    const files = signalClient.files(stash);
    const headRequest = readHead(files, path);
    const historyRequest = clientValue(files.history(path));
    const sourceRequest: Promise<FileRecord | null> =
      requestedSource === undefined
        ? Promise.resolve(null)
        : initialSource === undefined
          ? readStoredSource(files, path, requestedSource)
          : readFile(files, path, requestedSource);

    void Promise.all([headRequest, historyRequest, sourceRequest])
      .then(([head, history, selectedSource]) => {
        if (
          controller.signal.aborted ||
          runtimeRef.current !== runtime ||
          runtime.initialSequence !== sequence
        ) {
          return;
        }
        const selected = selectedSource ?? head;
        const storedDraftIsSafe =
          stored.record !== null &&
          selectedSource !== null &&
          canRestoreDraft(stored.record, selected, head, initialSource) &&
          normalizeTextareaText(stored.record.text) !== bodyText(selected);
        const source = initialSource !== undefined || storedDraftIsSafe ? selected : head;
        let draftPersistError = initial.draftPersistError;
        if (stored.record !== null && !storedDraftIsSafe) {
          if (!clearWorkbenchDraft(stash, path)) draftPersistError = "draft not persisted";
        }
        runtime.records.set(head.version, head);
        runtime.records.set(source.version, source);
        const sourceLineEnding = detectLineEnding(source.body);
        const restoredRecord: WorkbenchDraftRecord | null =
          storedDraftIsSafe && stored.record !== null
            ? { ...stored.record, text: normalizeTextareaText(stored.record.text) }
            : null;
        const draft = restoredRecord?.text ?? bodyText(source);
        const next: WorkbenchSnapshot = {
          ...initial,
          state: "ready",
          head,
          source,
          comparison: head,
          comparisonMode: "head",
          historyPage: normalizeHistory(history),
          historyLoading: false,
          draft,
          draftRecord: restoredRecord,
          draftRestored: restoredRecord !== null,
          draftPersistError,
          lineEnding: restoredRecord?.lineEnding ?? sourceLineEnding,
          sourceNotice: noticeForSource(source),
        };
        commit(runtime, next);
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          runtimeRef.current === runtime &&
          runtime.initialSequence === sequence
        ) {
          commit(runtime, { ...initial, state: "error", error, historyLoading: false });
        }
      });

    return () => controller.abort();
  }, [clientForSignal, commit, initialSource, path, stash, target]);

  const reloadHistoryFor = useCallback(
    (runtime: TargetRuntime, externalSignal?: AbortSignal): Promise<boolean> => {
      const execute = async (): Promise<boolean> => {
        if (runtimeRef.current !== runtime) return false;
        const controller = new AbortController();
        runtime.historyController = controller;
        const signal =
          externalSignal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, externalSignal]);
        const sequence = ++runtime.historySequence;
        commit(runtime, {
          ...runtime.snapshot,
          historyLoading: true,
          historyError: null,
        });
        try {
          signal.throwIfAborted();
          const page = await clientValue(
            runtime.target
              .clientForSignal(signal)
              .files(runtime.target.stash)
              .history(runtime.target.path),
          );
          signal.throwIfAborted();
          if (runtimeRef.current !== runtime || runtime.historySequence !== sequence) return false;
          return commit(runtime, {
            ...runtime.snapshot,
            historyPage: normalizeHistory(page),
            historyLoading: false,
            historyError: null,
          });
        } catch (error: unknown) {
          if (
            !signal.aborted &&
            runtimeRef.current === runtime &&
            runtime.historySequence === sequence
          ) {
            commit(runtime, {
              ...runtime.snapshot,
              historyLoading: false,
              historyError: error,
            });
          }
          return false;
        } finally {
          if (runtime.historyController === controller) runtime.historyController = null;
        }
      };

      const request = runtime.historyTail.then(execute, execute);
      runtime.historyTail = request.then(
        () => undefined,
        () => undefined,
      );
      return request;
    },
    [commit],
  );

  const reloadHistory = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const runtime = runtimeRef.current;
      return sameTarget(runtime.target, target) ? reloadHistoryFor(runtime, signal) : false;
    },
    [reloadHistoryFor, target],
  );

  const performSourceLoad = useCallback(
    async (runtime: TargetRuntime, version: number, intent: number): Promise<SourceLoadResult> => {
      if (runtimeRef.current !== runtime || runtime.sourceIntent !== intent) {
        return { status: "cancelled" };
      }
      runtime.sourceController?.abort();
      const controller = new AbortController();
      runtime.sourceController = controller;
      const sequence = ++runtime.sourceSequence;
      commit(runtime, {
        ...runtime.snapshot,
        sourceLoading: true,
        sourceError: null,
      });
      try {
        const cached = runtime.records.get(version);
        const source =
          cached ??
          (await readFile(
            runtime.target.clientForSignal(controller.signal).files(runtime.target.stash),
            runtime.target.path,
            version,
          ));
        if (
          controller.signal.aborted ||
          runtimeRef.current !== runtime ||
          runtime.sourceSequence !== sequence ||
          runtime.sourceIntent !== intent
        ) {
          return { status: "cancelled" };
        }
        runtime.records.set(source.version, source);
        const cleared = clearWorkbenchDraft(runtime.target.stash, runtime.target.path);
        const next: WorkbenchSnapshot = {
          ...runtime.snapshot,
          source,
          sourceLoading: false,
          sourceError: null,
          draft: bodyText(source),
          draftRecord: null,
          draftRestored: false,
          draftPersistError: cleared ? null : "draft not persisted",
          sourceNotice: noticeForSource(source),
          lineEnding: detectLineEnding(source.body),
        };
        commit(runtime, next);
        return { status: "loaded", source };
      } catch (error: unknown) {
        if (
          !controller.signal.aborted &&
          runtimeRef.current === runtime &&
          runtime.sourceSequence === sequence &&
          runtime.sourceIntent === intent
        ) {
          commit(runtime, {
            ...runtime.snapshot,
            sourceLoading: false,
            sourceError: error,
          });
          return { status: "error", error };
        }
        return { status: "cancelled" };
      }
    },
    [commit],
  );

  const loadSource = useCallback(
    async (version: number): Promise<SourceLoadResult> => {
      const runtime = runtimeRef.current;
      if (!sameTarget(runtime.target, target) || runtime.snapshot.state !== "ready") {
        return { status: "cancelled" };
      }
      if (!validVersion(version)) {
        const error = errorForVersion(version);
        commit(runtime, { ...runtime.snapshot, sourceError: error });
        return { status: "error", error };
      }
      const intent = ++runtime.sourceIntent;
      const dirty = runtime.snapshot.draft !== bodyText(runtime.snapshot.source);
      if (!dirty) return performSourceLoad(runtime, version, intent);

      let settled = false;
      return {
        status: "confirmation-required",
        version,
        async resolve(confirmed: boolean): Promise<SourceLoadResult> {
          if (settled) return { status: "cancelled" };
          settled = true;
          if (!confirmed || runtimeRef.current !== runtime || runtime.sourceIntent !== intent) {
            return { status: "cancelled" };
          }
          return performSourceLoad(runtime, version, intent);
        },
      };
    },
    [commit, performSourceLoad, target],
  );

  const setComparison = useCallback(
    async (nextComparison: WorkbenchComparison): Promise<boolean> => {
      const runtime = runtimeRef.current;
      if (!sameTarget(runtime.target, target) || runtime.snapshot.state !== "ready") return false;
      runtime.comparisonController?.abort();
      const sequence = ++runtime.comparisonSequence;

      if (nextComparison === "head") {
        return commit(runtime, {
          ...runtime.snapshot,
          comparison: runtime.snapshot.head,
          comparisonMode: "head",
          comparisonLoading: false,
          comparisonError: null,
        });
      }
      if (!validVersion(nextComparison)) {
        const error = errorForVersion(nextComparison);
        commit(runtime, { ...runtime.snapshot, comparisonError: error });
        return false;
      }

      const cached = runtime.records.get(nextComparison);
      if (cached !== undefined) {
        return commit(runtime, {
          ...runtime.snapshot,
          comparison: cached,
          comparisonMode: nextComparison,
          comparisonLoading: false,
          comparisonError: null,
        });
      }

      const controller = new AbortController();
      runtime.comparisonController = controller;
      commit(runtime, {
        ...runtime.snapshot,
        comparisonLoading: true,
        comparisonError: null,
      });
      try {
        const record = await readFile(
          runtime.target.clientForSignal(controller.signal).files(runtime.target.stash),
          runtime.target.path,
          nextComparison,
        );
        if (
          controller.signal.aborted ||
          runtimeRef.current !== runtime ||
          runtime.comparisonSequence !== sequence
        ) {
          return false;
        }
        runtime.records.set(record.version, record);
        return commit(runtime, {
          ...runtime.snapshot,
          comparison: record,
          comparisonMode: nextComparison,
          comparisonLoading: false,
          comparisonError: null,
        });
      } catch (error: unknown) {
        if (
          !controller.signal.aborted &&
          runtimeRef.current === runtime &&
          runtime.comparisonSequence === sequence
        ) {
          commit(runtime, {
            ...runtime.snapshot,
            comparisonLoading: false,
            comparisonError: error,
          });
        }
        return false;
      }
    },
    [commit, target],
  );

  const setDraft = useCallback(
    (text: string): void => {
      const runtime = runtimeRef.current;
      if (!sameTarget(runtime.target, target) || runtime.snapshot.state !== "ready") return;
      const normalized = normalizeTextareaText(text);
      const current = runtime.snapshot;
      if (current.source === null || current.head === null) return;
      const dirty = normalized !== bodyText(current.source);
      let record: WorkbenchDraftRecord | null = null;
      let persisted = true;
      if (dirty) {
        record = {
          sourceVersion: current.source.version,
          fenceVersion: current.head.version,
          text: normalized,
          lineEnding: current.lineEnding,
          savedAt: Date.now(),
        };
        persisted = storeDraft(runtime.target.stash, runtime.target.path, record);
      } else {
        persisted = clearWorkbenchDraft(runtime.target.stash, runtime.target.path);
      }
      commit(runtime, {
        ...current,
        draft: normalized,
        draftRecord: record,
        draftPersistError: persisted ? null : "draft not persisted",
      });
    },
    [commit, target],
  );

  const discard = useCallback((): void => {
    const runtime = runtimeRef.current;
    if (!sameTarget(runtime.target, target) || runtime.snapshot.source === null) return;
    const cleared = clearWorkbenchDraft(runtime.target.stash, runtime.target.path);
    commit(runtime, {
      ...runtime.snapshot,
      draft: bodyText(runtime.snapshot.source),
      draftRecord: null,
      draftRestored: false,
      draftPersistError: cleared ? null : "draft not persisted",
      lineEnding: detectLineEnding(runtime.snapshot.source.body),
    });
  }, [commit, target]);

  const clearForLogout = useCallback((): boolean => {
    const cleared = clearWorkbenchDraftsForCredentialChange();
    const runtime = runtimeRef.current;
    if (sameTarget(runtime.target, target)) {
      commit(runtime, {
        ...runtime.snapshot,
        draftRecord: null,
        draftRestored: false,
        draftPersistError: cleared ? null : "draft not persisted",
      });
    }
    return cleared;
  }, [commit, target]);

  const afterSaved = useCallback(
    async (record: FileRecord): Promise<boolean> => {
      const runtime = runtimeRef.current;
      if (!sameTarget(runtime.target, target) || runtime.snapshot.state !== "ready") return false;
      const currentHead = runtime.snapshot.head;
      if (currentHead !== null && record.version < currentHead.version) return false;
      runtime.initialController?.abort();
      runtime.initialSequence += 1;
      runtime.sourceController?.abort();
      runtime.sourceSequence += 1;
      runtime.sourceIntent += 1;
      runtime.records.set(record.version, record);
      const cleared = clearWorkbenchDraft(runtime.target.stash, runtime.target.path);
      const next: WorkbenchSnapshot = {
        ...runtime.snapshot,
        head: record,
        source: record,
        comparison:
          runtime.snapshot.comparisonMode === "head" ? record : runtime.snapshot.comparison,
        draft: bodyText(record),
        draftRecord: null,
        draftRestored: false,
        draftPersistError: cleared ? null : "draft not persisted",
        sourceNotice: noticeForSource(record),
        lineEnding: detectLineEnding(record.body),
        sourceLoading: false,
        sourceError: null,
      };
      if (!commit(runtime, next)) return false;
      return reloadHistoryFor(runtime);
    },
    [commit, reloadHistoryFor, target],
  );

  const afterStaleReload = useCallback(
    (record: FileRecord): void => {
      const runtime = runtimeRef.current;
      if (!sameTarget(runtime.target, target) || runtime.snapshot.state !== "ready") return;
      const currentHead = runtime.snapshot.head;
      if (currentHead !== null && record.version < currentHead.version) return;
      runtime.initialController?.abort();
      runtime.initialSequence += 1;
      runtime.records.set(record.version, record);
      const current = runtime.snapshot;
      let draftRecord = current.draftRecord;
      let persisted = true;
      if (draftRecord !== null && current.source !== null) {
        draftRecord = { ...draftRecord, fenceVersion: record.version, savedAt: Date.now() };
        persisted = storeDraft(runtime.target.stash, runtime.target.path, draftRecord);
      }
      commit(runtime, {
        ...current,
        head: record,
        comparison: current.comparisonMode === "head" ? record : current.comparison,
        draftRecord,
        draftPersistError: persisted ? null : "draft not persisted",
      });
    },
    [commit, target],
  );

  const frozenBody = applyLineEnding(snapshot.draft, snapshot.lineEnding);
  const dirtyFromSource = snapshot.source !== null && snapshot.draft !== bodyText(snapshot.source);
  const displayBase = bodyText(snapshot.comparison);
  const saveBase = bodyText(snapshot.head);
  const displayCandidate = useSettledCandidate(target, displayBase, snapshot.draft);
  const saveCandidate = useSettledCandidate(target, saveBase, snapshot.draft);
  const [hashEntry, setHashEntry] = useState<HashEntry>(() => ({
    target,
    headHash: snapshot.head?.hash ?? null,
    body: frozenBody,
    same: false,
    pending: snapshot.head?.hash !== null && snapshot.head !== null,
  }));
  const hashMatches =
    sameTarget(hashEntry.target, target) &&
    hashEntry.headHash === (snapshot.head?.hash ?? null) &&
    hashEntry.body === frozenBody;

  useEffect(() => {
    const headHash = snapshot.head?.hash ?? null;
    let active = true;
    if (headHash === null) {
      setHashEntry({ target, headHash, body: frozenBody, same: false, pending: false });
      return () => {
        active = false;
      };
    }
    setHashEntry({ target, headHash, body: frozenBody, same: false, pending: true });
    void sha256Hex(frozenBody).then(
      (hash) => {
        if (active) {
          setHashEntry({
            target,
            headHash,
            body: frozenBody,
            same: hash === headHash,
            pending: false,
          });
        }
      },
      () => {
        if (active) {
          setHashEntry({ target, headHash, body: frozenBody, same: false, pending: false });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [frozenBody, snapshot.head?.hash, target]);

  return {
    state: snapshot.state,
    error: snapshot.error,
    head: snapshot.head,
    source: snapshot.source,
    comparison: snapshot.comparison,
    comparisonMode: snapshot.comparisonMode,
    versions: snapshot.historyPage?.versions ?? [],
    historyPage: snapshot.historyPage,
    historyLoading: snapshot.historyLoading,
    historyError: snapshot.historyError,
    sourceLoading: snapshot.sourceLoading,
    sourceError: snapshot.sourceError,
    comparisonLoading: snapshot.comparisonLoading,
    comparisonError: snapshot.comparisonError,
    draft: snapshot.draft,
    draftRecord: snapshot.draftRecord,
    draftRestored: snapshot.draftRestored,
    draftPersistError: snapshot.draftPersistError,
    sourceNotice: snapshot.sourceNotice,
    lineEnding: snapshot.lineEnding,
    frozenBody,
    dirtyFromSource,
    displayDiff: displayCandidate.value,
    displayDiffPending: displayCandidate.pending,
    sameAsHead: hashMatches ? hashEntry.same : false,
    sameAsHeadPending: hashMatches ? hashEntry.pending : snapshot.head?.hash !== null,
    saveDiff: saveCandidate.value,
    saveDiffPending: saveCandidate.pending,
    setDraft,
    loadSource,
    setComparison,
    discard,
    clearForLogout,
    afterSaved,
    afterStaleReload,
    reloadHistory,
  };
}
