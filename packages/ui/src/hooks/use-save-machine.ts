import type {
  Current,
  FileRecord,
  FileRecordWithEtag,
  StashClient,
} from "@takazudo/zudo-history-stash";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type LineEnding = "lf" | "crlf";

export interface SaveMachineOptions {
  client: StashClient;
  stash: string;
  path: string;
  head: Pick<FileRecord, "version" | "hash">;
  draft: string;
  lineEnding: LineEnding;
}

export interface SaveMetadata {
  author: string;
  message: string;
}

export type SaveMachineState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; version: number; changeId: number }
  | { state: "unchanged"; version: number }
  | { state: "stale"; current: Current }
  | { state: "error"; message: string };

export type SaveMachine = SaveMachineState & {
  /** Opaque identity for the active client/stash/path lifecycle. */
  targetIdentity: object;
  canRetry: boolean;
  save: (metadata: SaveMetadata) => Promise<void>;
  retry: () => Promise<void>;
  reloadAndCompare: () => Promise<FileRecordWithEtag>;
  reconcile: () => Promise<boolean>;
  /** Clears terminal state and a frozen retry when no operation is pending. */
  resetSession: () => boolean;
};

interface FrozenSaveAttempt {
  target: SaveTarget;
  runtime: TargetRuntime;
  idempotencyKey: string;
  input: {
    body: string;
    expectedVersion: number;
    author: string;
    message: string;
  };
}

interface SaveTarget {
  client: StashClient;
  stash: string;
  path: string;
}

interface HeadFence {
  version: number;
  hash: string | null;
}

interface RenderSnapshot {
  target: SaveTarget;
  head: HeadFence;
  draft: string;
  lineEnding: LineEnding;
}

interface TargetRuntime {
  target: SaveTarget;
  committedSnapshot: RenderSnapshot;
  effectiveHead: HeadFence;
  generation: number;
}

const IDLE_STATE: SaveMachineState = { state: "idle" };

function createTargetRuntime(snapshot: RenderSnapshot): TargetRuntime {
  return {
    target: snapshot.target,
    committedSnapshot: snapshot,
    effectiveHead: { version: snapshot.head.version, hash: snapshot.head.hash },
    generation: 0,
  };
}

function sameTarget(left: SaveTarget, right: SaveTarget): boolean {
  return left.client === right.client && left.stash === right.stash && left.path === right.path;
}

/** Reapplies the source file's line-ending policy to a textarea-normalized draft. */
export function applyLineEnding(text: string, lineEnding: LineEnding): string {
  const lf = text.replace(/\r\n?|\n/g, "\n");
  return lineEnding === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error("History Stash request failed");
}

/** Owns one editor's compare-and-swap save lifecycle. */
export function useSaveMachine({
  client,
  stash,
  path,
  head,
  draft,
  lineEnding,
}: SaveMachineOptions): SaveMachine {
  const renderedTarget = useMemo<SaveTarget>(
    () => ({ client, stash, path }),
    [client, path, stash],
  );
  const [, setMachineRevision] = useState(0);
  const machineStatesRef = useRef(new WeakMap<SaveTarget, SaveMachineState>());
  const mountedRef = useRef(true);
  const inFlightTargetsRef = useRef(new Set<SaveTarget>());
  const reloadingTargetsRef = useRef(new Set<SaveTarget>());
  const reconcilingTargetsRef = useRef(new Set<SaveTarget>());
  const retryAttemptRef = useRef<FrozenSaveAttempt | null>(null);
  const initialSnapshot: RenderSnapshot = {
    target: renderedTarget,
    head: { version: head.version, hash: head.hash },
    draft,
    lineEnding,
  };
  const runtimeRef = useRef<TargetRuntime>(createTargetRuntime(initialSnapshot));
  const targetIsCommitted = sameTarget(runtimeRef.current.target, renderedTarget);
  const target = targetIsCommitted ? runtimeRef.current.target : renderedTarget;
  const renderSnapshot = useMemo<RenderSnapshot>(
    () => ({
      target,
      head: { version: head.version, hash: head.hash },
      draft,
      lineEnding,
    }),
    [draft, head.hash, head.version, lineEnding, target],
  );
  const machine = targetIsCommitted
    ? (machineStatesRef.current.get(target) ?? IDLE_STATE)
    : IDLE_STATE;
  const canRetry =
    targetIsCommitted && machine.state === "error" && retryAttemptRef.current?.target === target;

  // Concurrent renders only derive snapshots above; shared lifecycle refs change after commit.
  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime.target !== target) {
      runtimeRef.current = createTargetRuntime(renderSnapshot);
      if (retryAttemptRef.current?.target !== target) retryAttemptRef.current = null;
      return;
    }

    const previousSnapshot = runtime.committedSnapshot;
    const headChanged =
      previousSnapshot.head.version !== renderSnapshot.head.version ||
      previousSnapshot.head.hash !== renderSnapshot.head.hash;
    const candidateChanged =
      previousSnapshot.draft !== renderSnapshot.draft ||
      previousSnapshot.lineEnding !== renderSnapshot.lineEnding;
    if (headChanged) {
      if (renderSnapshot.head.version >= runtime.effectiveHead.version) {
        runtime.effectiveHead = {
          version: renderSnapshot.head.version,
          hash: renderSnapshot.head.hash,
        };
      }
    }
    runtime.committedSnapshot = renderSnapshot;
    if (headChanged || candidateChanged) runtime.generation += 1;
  }, [renderSnapshot, target]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const transition = useCallback((transitionTarget: SaveTarget, state: SaveMachineState) => {
    if (!mountedRef.current) return;
    machineStatesRef.current.set(transitionTarget, state);
    setMachineRevision((revision) => revision + 1);
  }, []);

  const runAttempt = useCallback(
    async (attempt: FrozenSaveAttempt): Promise<void> => {
      if (
        inFlightTargetsRef.current.has(attempt.target) ||
        reloadingTargetsRef.current.has(attempt.target)
      ) {
        return;
      }

      inFlightTargetsRef.current.add(attempt.target);
      attempt.runtime.generation += 1;
      retryAttemptRef.current = attempt;
      transition(attempt.target, { state: "saving" });

      try {
        const result = await attempt.target.client
          .files(attempt.target.stash)
          .put(attempt.target.path, attempt.input, {
            idempotencyKey: attempt.idempotencyKey,
          });

        if (result.ok) {
          if (retryAttemptRef.current === attempt) retryAttemptRef.current = null;
          if ("unchanged" in result.value) {
            if (result.value.version >= attempt.runtime.effectiveHead.version) {
              attempt.runtime.effectiveHead = {
                version: result.value.version,
                hash: attempt.runtime.effectiveHead.hash,
              };
            }
            attempt.runtime.generation += 1;
            transition(attempt.target, { state: "unchanged", version: result.value.version });
          } else {
            if (result.value.version >= attempt.runtime.effectiveHead.version) {
              attempt.runtime.effectiveHead = {
                version: result.value.version,
                hash: result.value.hash,
              };
            }
            attempt.runtime.generation += 1;
            transition(attempt.target, {
              state: "saved",
              version: result.value.version,
              changeId: result.value.changeId,
            });
          }
          return;
        }

        if (retryAttemptRef.current === attempt) retryAttemptRef.current = null;
        if (result.error.code === "stale" && result.current !== undefined) {
          transition(attempt.target, { state: "stale", current: result.current });
          return;
        }

        transition(attempt.target, { state: "error", message: result.error.message });
      } catch (error) {
        const failure = errorFrom(error);
        transition(attempt.target, { state: "error", message: failure.message });
      } finally {
        inFlightTargetsRef.current.delete(attempt.target);
      }
    },
    [transition],
  );

  const save = useCallback(
    async ({ author, message }: SaveMetadata): Promise<void> => {
      const runtime = runtimeRef.current;
      if (runtime.target !== target || runtime.committedSnapshot !== renderSnapshot) return;

      const attempt: FrozenSaveAttempt = {
        target,
        runtime,
        idempotencyKey: globalThis.crypto.randomUUID(),
        input: {
          body: applyLineEnding(renderSnapshot.draft, renderSnapshot.lineEnding),
          expectedVersion: runtime.effectiveHead.version,
          author,
          message,
        },
      };
      await runAttempt(attempt);
    },
    [renderSnapshot, runAttempt, target],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (runtimeRef.current.target !== target) return;

    const attempt = retryAttemptRef.current;
    if (attempt?.target === target) {
      await runAttempt(attempt);
    } else if (attempt !== null) {
      retryAttemptRef.current = null;
    }
  }, [runAttempt, target]);

  const reloadAndCompare = useCallback(async (): Promise<FileRecordWithEtag> => {
    const runtime = runtimeRef.current;
    if (runtime.target !== target) throw new Error("The save target is no longer active");

    if (inFlightTargetsRef.current.has(target) || reloadingTargetsRef.current.has(target)) {
      throw new Error("A save or reload is already in progress");
    }

    if (retryAttemptRef.current?.target === target) retryAttemptRef.current = null;
    reloadingTargetsRef.current.add(target);
    runtime.generation += 1;
    try {
      let result = await target.client.files(target.stash).get(target.path);
      if (!result.ok && result.error.code === "file-deleted" && result.current !== undefined) {
        result = await target.client
          .files(target.stash)
          .get(target.path, { version: result.current.version });
      }

      if (result.ok && !("notModified" in result)) {
        if (result.value.version >= runtime.effectiveHead.version) {
          runtime.effectiveHead = {
            version: result.value.version,
            hash: result.value.hash,
          };
        }
        runtime.generation += 1;
        transition(target, { state: "idle" });
        return result.value;
      }

      const failure = new Error(
        result.ok ? "The current file could not be reloaded" : result.error.message,
      );
      throw failure;
    } catch (error) {
      const failure = errorFrom(error);
      transition(target, { state: "error", message: failure.message });
      throw failure;
    } finally {
      reloadingTargetsRef.current.delete(target);
    }
  }, [target, transition]);

  const reconcile = useCallback(async (): Promise<boolean> => {
    const runtime = runtimeRef.current;
    if (runtime.target !== target || runtime.committedSnapshot !== renderSnapshot) return false;

    if (
      inFlightTargetsRef.current.has(target) ||
      reloadingTargetsRef.current.has(target) ||
      reconcilingTargetsRef.current.has(target)
    ) {
      return false;
    }

    const generation = ++runtime.generation;
    const expectedHead = { ...runtime.effectiveHead };
    reconcilingTargetsRef.current.add(target);
    try {
      const hash = await sha256Hex(
        applyLineEnding(renderSnapshot.draft, renderSnapshot.lineEnding),
      );
      if (
        runtimeRef.current !== runtime ||
        runtime.committedSnapshot !== renderSnapshot ||
        runtime.generation !== generation ||
        inFlightTargetsRef.current.has(target) ||
        reloadingTargetsRef.current.has(target) ||
        hash !== expectedHead.hash
      ) {
        return false;
      }

      if (retryAttemptRef.current?.target === target) retryAttemptRef.current = null;
      transition(target, { state: "unchanged", version: expectedHead.version });
      return true;
    } finally {
      reconcilingTargetsRef.current.delete(target);
    }
  }, [renderSnapshot, target, transition]);

  const resetSession = useCallback((): boolean => {
    const runtime = runtimeRef.current;
    if (
      runtime.target !== target ||
      inFlightTargetsRef.current.has(target) ||
      reloadingTargetsRef.current.has(target) ||
      reconcilingTargetsRef.current.has(target)
    ) {
      return false;
    }

    runtime.generation += 1;
    runtime.effectiveHead = { ...runtime.committedSnapshot.head };
    if (retryAttemptRef.current?.target === target) retryAttemptRef.current = null;
    transition(target, IDLE_STATE);
    return true;
  }, [target, transition]);

  return {
    ...machine,
    targetIdentity: target,
    canRetry,
    save,
    retry,
    reloadAndCompare,
    reconcile,
    resetSession,
  } as SaveMachine;
}
