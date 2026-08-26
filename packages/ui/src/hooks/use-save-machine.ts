import type {
  Current,
  FileRecord,
  FileRecordWithEtag,
  StashClient,
} from "@takazudo/zudo-history-stash";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { useCallback, useEffect, useRef, useState } from "react";

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
  save: (metadata: SaveMetadata) => Promise<void>;
  retry: () => Promise<void>;
  reloadAndCompare: () => Promise<FileRecordWithEtag>;
  reconcile: () => Promise<boolean>;
};

interface FrozenSaveAttempt {
  client: StashClient;
  stash: string;
  path: string;
  idempotencyKey: string;
  input: {
    body: string;
    expectedVersion: number;
    author: string;
    message: string;
  };
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
  const [machine, setMachine] = useState<SaveMachineState>({ state: "idle" });
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const retryAttemptRef = useRef<FrozenSaveAttempt | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const transition = useCallback((state: SaveMachineState) => {
    if (mountedRef.current) setMachine(state);
  }, []);

  const runAttempt = useCallback(
    async (attempt: FrozenSaveAttempt): Promise<void> => {
      if (inFlightRef.current) return;

      inFlightRef.current = true;
      retryAttemptRef.current = attempt;
      transition({ state: "saving" });

      try {
        const result = await attempt.client.files(attempt.stash).put(attempt.path, attempt.input, {
          idempotencyKey: attempt.idempotencyKey,
        });

        if (result.ok) {
          retryAttemptRef.current = null;
          if ("unchanged" in result.value) {
            transition({ state: "unchanged", version: result.value.version });
          } else {
            transition({
              state: "saved",
              version: result.value.version,
              changeId: result.value.changeId,
            });
          }
          return;
        }

        retryAttemptRef.current = null;
        if (result.error.code === "stale" && result.current !== undefined) {
          transition({ state: "stale", current: result.current });
          return;
        }

        transition({ state: "error", message: result.error.message });
      } catch (error) {
        const failure = errorFrom(error);
        transition({ state: "error", message: failure.message });
      } finally {
        inFlightRef.current = false;
      }
    },
    [transition],
  );

  const save = useCallback(
    async ({ author, message }: SaveMetadata): Promise<void> => {
      const attempt: FrozenSaveAttempt = {
        client,
        stash,
        path,
        idempotencyKey: globalThis.crypto.randomUUID(),
        input: {
          body: applyLineEnding(draft, lineEnding),
          expectedVersion: head.version,
          author,
          message,
        },
      };
      await runAttempt(attempt);
    },
    [client, draft, head.version, lineEnding, path, runAttempt, stash],
  );

  const retry = useCallback(async (): Promise<void> => {
    const attempt = retryAttemptRef.current;
    if (attempt !== null) await runAttempt(attempt);
  }, [runAttempt]);

  const reloadAndCompare = useCallback(async (): Promise<FileRecordWithEtag> => {
    if (inFlightRef.current) throw new Error("A save is already in progress");

    retryAttemptRef.current = null;
    try {
      let result = await client.files(stash).get(path);
      if (!result.ok && result.error.code === "file-deleted" && result.current !== undefined) {
        result = await client.files(stash).get(path, { version: result.current.version });
      }

      if (result.ok && !("notModified" in result)) {
        transition({ state: "idle" });
        return result.value;
      }

      const failure = new Error(
        result.ok ? "The current file could not be reloaded" : result.error.message,
      );
      throw failure;
    } catch (error) {
      const failure = errorFrom(error);
      transition({ state: "error", message: failure.message });
      throw failure;
    }
  }, [client, path, stash, transition]);

  const reconcile = useCallback(async (): Promise<boolean> => {
    const hash = await sha256Hex(applyLineEnding(draft, lineEnding));
    if (hash !== head.hash) return false;

    retryAttemptRef.current = null;
    transition({ state: "unchanged", version: head.version });
    return true;
  }, [draft, head.hash, head.version, lineEnding, transition]);

  return { ...machine, save, retry, reloadAndCompare, reconcile } as SaveMachine;
}
