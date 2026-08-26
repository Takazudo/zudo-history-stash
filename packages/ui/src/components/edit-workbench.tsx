import type {
  FileGetResult,
  FileRecord,
  FileRecordWithEtag,
  StashClient,
} from "@takazudo/zudo-history-stash";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { useDiffViewPreferences } from "../hooks/use-diff-view-preferences.js";
import { useSaveMachine, type SaveMachine } from "../hooks/use-save-machine.js";
import {
  useWorkbench,
  type SourceLoadResult,
  type WorkbenchState,
} from "../hooks/use-workbench.js";
import { useCanWrite, useMe, useStashClient } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Notice, type NoticeVariant } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { DiffControls } from "./diff-controls.js";
import { DiffPane } from "./diff-pane.js";
import { ErrorBanner, stashErrorMessage } from "./error-banner.js";
import { HistoryRail } from "./history-rail.js";
import { SaveReviewDialog, type SaveReviewCompletion } from "./save-review-dialog.js";

type SourceConfirmation = Extract<SourceLoadResult, { status: "confirmation-required" }>;
type PaneTab = "editor" | "diff";

export interface EditWorkbenchSaved {
  completion: SaveReviewCompletion;
  record: FileRecord;
}

export interface EditWorkbenchProps {
  stash: string;
  path: string;
  initialSource?: number;
  onSaved?: (result: EditWorkbenchSaved) => void;
}

interface WorkbenchFlash {
  variant: "success" | "info";
  version: number;
}

function fileRecordFrom(result: FileGetResult): FileRecordWithEtag {
  if (!result.ok) throw result;
  if ("notModified" in result) throw new Error("The saved file representation was not returned");
  return result.value;
}

async function readSavedRecord(
  client: StashClient,
  stash: string,
  path: string,
  version: number,
): Promise<FileRecordWithEtag> {
  return fileRecordFrom(await client.files(stash).get(path, { version }));
}

function comparisonLabel(workbench: WorkbenchState): string {
  const version = workbench.comparison?.version;
  if (version === undefined) return "comparison unavailable";
  return workbench.comparisonMode === "head" ? `head v${version}` : `v${version}`;
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}

function Gate({ path, children }: { path: string; children: ReactNode }) {
  const titleId = useId();

  return (
    <section className="zhs-edit-workbench zhs-edit-workbench--gate" aria-labelledby={titleId}>
      <header className="zhs-edit-workbench__heading">
        <div className="zhs-edit-workbench__identity">
          <p className="zhs-edit-workbench__eyebrow">Edit</p>
          <h1 className="zhs-edit-workbench__title" id={titleId}>
            {path}
          </h1>
        </div>
      </header>
      <div className="zhs-edit-workbench__gate-content">{children}</div>
    </section>
  );
}

function EditWorkbenchAllowed({ stash, path, initialSource, onSaved }: EditWorkbenchProps) {
  const workbench = useWorkbench({ stash, path, initialSource });

  if (workbench.state === "loading") {
    return (
      <Gate path={path}>
        <Notice>Loading edit workbench…</Notice>
      </Gate>
    );
  }

  if (workbench.state === "error" || workbench.head === null || workbench.source === null) {
    return (
      <Gate path={path}>
        <ErrorBanner error={workbench.error ?? new Error("The workbench did not load")} />
      </Gate>
    );
  }

  return (
    <EditWorkbenchReady
      key={`${stash}\u0000${path}\u0000${String(initialSource ?? "head")}`}
      onSaved={onSaved}
      path={path}
      stash={stash}
      workbench={workbench}
    />
  );
}

interface BannerState {
  variant: NoticeVariant;
  content: ReactNode;
}

function bannerFor({
  workbench,
  machine,
  sourceConfirmation,
  flash,
  completionError,
}: {
  workbench: WorkbenchState;
  machine: SaveMachine;
  sourceConfirmation: SourceConfirmation | null;
  flash: WorkbenchFlash | null;
  completionError: unknown | null;
}): BannerState {
  const sourceVersion = workbench.source?.version;
  const headVersion = workbench.head?.version;
  const compare = comparisonLabel(workbench);
  const additions: string[] = [];
  if (workbench.draftRestored) additions.push("Restored unsaved draft.");
  if (workbench.sourceNotice) additions.push(workbench.sourceNotice);
  if (workbench.draftPersistError) additions.push("Draft not persisted.");
  const supplement = additions.length > 0 ? <span>{additions.join(" ")}</span> : null;

  if (sourceConfirmation !== null) {
    return {
      variant: "warning",
      content: (
        <>
          <strong>Load v{sourceConfirmation.version} into the editor?</strong>
          <span>
            Your draft has unsaved changes against v{sourceVersion}; loading replaces them.
          </span>
          {supplement}
        </>
      ),
    };
  }

  if (machine.state === "stale") {
    return {
      variant: "error",
      content: (
        <>
          <strong>
            Head moved to v{machine.current.version} by {machine.current.author || "unknown author"}
          </strong>
          <span>
            This draft remains fenced to v{headVersion}. Reload and compare in the save review
            before making another save attempt.
          </span>
          {supplement}
        </>
      ),
    };
  }

  if (completionError !== null) {
    return {
      variant: "error",
      content: (
        <>
          <strong>The save completed, but the updated file could not be loaded.</strong>
          <span>{stashErrorMessage(completionError)}</span>
          {supplement}
        </>
      ),
    };
  }

  if (flash !== null) {
    return {
      variant: flash.variant,
      content: (
        <>
          <strong>
            {flash.variant === "success"
              ? `Saved v${flash.version}. The history rail and head fence are refreshed.`
              : `Nothing was written. The draft already matches head v${flash.version}.`}
          </strong>
          {supplement}
        </>
      ),
    };
  }

  if (sourceVersion !== undefined && headVersion !== undefined && sourceVersion !== headVersion) {
    return {
      variant: "warning",
      content: (
        <>
          <strong>Editing from v{sourceVersion}</strong>
          <span>
            The draft still saves on top of head v{headVersion}. {additions.join(" ")}
          </span>
        </>
      ),
    };
  }

  return {
    variant: "info",
    content: (
      <span>
        Base: head v{headVersion} · saving creates v{(headVersion ?? 0) + 1} · comparing against{" "}
        {compare}.{additions.length > 0 ? ` ${additions.join(" ")}` : ""}
      </span>
    ),
  };
}

function EditWorkbenchReady({
  stash,
  path,
  workbench,
  onSaved,
}: {
  stash: string;
  path: string;
  workbench: WorkbenchState;
  onSaved?: (result: EditWorkbenchSaved) => void;
}) {
  const client = useStashClient();
  const titleId = useId();
  const preferences = useDiffViewPreferences();
  const [railOpen, setRailOpen] = useState(true);
  const [paneTab, setPaneTab] = useState<PaneTab>("editor");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sourceConfirmation, setSourceConfirmation] = useState<SourceConfirmation | null>(null);
  const [flash, setFlash] = useState<WorkbenchFlash | null>(null);
  const [completionError, setCompletionError] = useState<unknown | null>(null);
  const [completionPending, setCompletionPending] = useState(false);
  const completionPendingRef = useRef(false);
  const handledCompletionRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const diffRegionRef = useRef<HTMLDivElement>(null);
  const diffScrollTopRef = useRef(0);
  const head = workbench.head;
  const source = workbench.source;
  if (head === null || source === null) throw new Error("Ready workbench records are missing");

  const machine = useSaveMachine({
    client,
    stash,
    path,
    head,
    draft: workbench.draft,
    lineEnding: workbench.lineEnding,
  });

  const reloadAndCompare = useCallback(async () => {
    const record = await machine.reloadAndCompare();
    workbench.afterStaleReload(record);
    return record;
  }, [machine, workbench]);

  const dialogMachine = useMemo<SaveMachine>(
    () => ({ ...machine, reloadAndCompare }),
    [machine, reloadAndCompare],
  );

  const canSave =
    !workbench.sameAsHead &&
    !workbench.sameAsHeadPending &&
    !completionPending &&
    machine.state !== "saving";
  const banner = bannerFor({
    workbench,
    machine,
    sourceConfirmation,
    flash,
    completionError,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      completionPendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "s" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      if (canSave && !dialogOpen) setDialogOpen(true);
    }

    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [canSave, dialogOpen]);

  useLayoutEffect(() => {
    const pane = diffRegionRef.current?.querySelector<HTMLElement>(".zhs-diff-table-pane");
    if (pane !== undefined && pane !== null) pane.scrollTop = diffScrollTopRef.current;
  }, [preferences.effectiveLayout, workbench.displayDiff.model]);

  const requestSource = useCallback(
    async (version: number): Promise<void> => {
      setFlash(null);
      setCompletionError(null);
      setSourceConfirmation(null);
      const result = await workbench.loadSource(version);
      if (result.status === "confirmation-required") setSourceConfirmation(result);
    },
    [workbench],
  );

  const resolveSource = useCallback(
    async (confirmed: boolean): Promise<void> => {
      const request = sourceConfirmation;
      if (request === null) return;
      setSourceConfirmation(null);
      await request.resolve(confirmed);
    },
    [sourceConfirmation],
  );

  const handleSaved = useCallback(
    async (completion: SaveReviewCompletion): Promise<void> => {
      const completionKey = `${completion.state}:${completion.version}:${completion.state === "saved" ? completion.changeId : "unchanged"}`;
      if (completionPendingRef.current || handledCompletionRef.current === completionKey) return;
      completionPendingRef.current = true;
      handledCompletionRef.current = completionKey;
      setCompletionPending(true);
      setCompletionError(null);

      try {
        const record = await readSavedRecord(client, stash, path, completion.version);
        if (!mountedRef.current) return;
        const refresh = workbench.afterSaved(record);
        machine.resetSession();
        setDialogOpen(false);
        setSourceConfirmation(null);
        setFlash({
          variant: completion.state === "saved" ? "success" : "info",
          version: completion.version,
        });
        await refresh;
        if (!mountedRef.current) return;
        onSaved?.({ completion, record });
      } catch (error: unknown) {
        if (mountedRef.current) setCompletionError(error);
      } finally {
        if (mountedRef.current) setCompletionPending(false);
        completionPendingRef.current = false;
      }
    },
    [client, machine, onSaved, path, stash, workbench],
  );

  function handleDraftChange(value: string): void {
    setFlash(null);
    setCompletionError(null);
    workbench.setDraft(value);
  }

  function handleDiscard(): void {
    if (completionPendingRef.current) return;
    setSourceConfirmation(null);
    setFlash(null);
    setCompletionError(null);
    workbench.discard();
  }

  function closeDialog(): void {
    if (completionPendingRef.current) return;
    setDialogOpen(false);
  }

  function handleDiffScroll(event: UIEvent<HTMLDivElement>): void {
    const target = event.target;
    if (target instanceof HTMLElement && target.classList.contains("zhs-diff-table-pane")) {
      diffScrollTopRef.current = target.scrollTop;
    }
  }

  const comparison = comparisonLabel(workbench);
  const showEditor = !preferences.isNarrow || paneTab === "editor";
  const showDiff = !preferences.isNarrow || paneTab === "diff";
  const hasErrors = Boolean(
    workbench.sourceError || workbench.comparisonError || workbench.historyError,
  );

  return (
    <section
      className="zhs-edit-workbench"
      aria-labelledby={titleId}
      data-narrow={preferences.isNarrow ? "true" : "false"}
    >
      <header className="zhs-edit-workbench__heading">
        <div className="zhs-edit-workbench__identity">
          <p className="zhs-edit-workbench__eyebrow">Edit · {stash}</p>
          <div className="zhs-edit-workbench__title-line">
            <h1 className="zhs-edit-workbench__title" id={titleId}>
              {path}
            </h1>
            <span className="zhs-edit-workbench__head">head v{head.version}</span>
          </div>
        </div>
        <div className="zhs-edit-workbench__actions">
          <Button disabled={completionPending} onClick={handleDiscard}>
            Discard
          </Button>
          <Button disabled={!canSave} variant="primary" onClick={() => setDialogOpen(true)}>
            Save…
          </Button>
        </div>
      </header>

      <div className="zhs-edit-workbench__bar">
        {preferences.isNarrow ? (
          <div className="zhs-edit-workbench__tabs" aria-label="Pane" role="group">
            <Button
              aria-pressed={paneTab === "editor"}
              size="sm"
              onClick={() => setPaneTab("editor")}
            >
              Editor
            </Button>
            <Button aria-pressed={paneTab === "diff"} size="sm" onClick={() => setPaneTab("diff")}>
              Diff
            </Button>
          </div>
        ) : null}
        <DiffControls
          isNarrow={preferences.isNarrow}
          marks={preferences.marks}
          preferredLayout={preferences.preferredLayout}
          setMarks={preferences.setMarks}
          setPreferredLayout={preferences.setPreferredLayout}
          setWrap={preferences.setWrap}
          wrap={preferences.wrap}
        />
        <p className="zhs-edit-workbench__stats" aria-live="polite">
          <span className="zhs-edit-workbench__stats-add">
            +{workbench.displayDiff.stats.added}
          </span>
          <span className="zhs-edit-workbench__stats-remove">
            −{workbench.displayDiff.stats.removed}
          </span>
          <span>vs {comparison}</span>
        </p>
      </div>

      <div
        className="zhs-edit-workbench__body"
        data-pane={paneTab}
        data-rail={railOpen ? "open" : "closed"}
      >
        <HistoryRail
          comparison={workbench.comparisonMode}
          head={head}
          open={railOpen}
          source={source}
          versions={workbench.versions}
          onEditFrom={(version) => void requestSource(version)}
          onLoadSource={(version) => void requestSource(version)}
          onOpenChange={setRailOpen}
          onSetComparison={(next) => {
            setFlash(null);
            setCompletionError(null);
            void workbench.setComparison(next);
          }}
        />

        <section
          className="zhs-edit-workbench__pane zhs-edit-workbench__pane--editor"
          aria-label="Editor"
          hidden={!showEditor}
        >
          <div className="zhs-edit-workbench__pane-heading">
            <p className="zhs-edit-workbench__pane-title">
              <strong>Editor</strong>
              <span>
                draft from v{source.version} · {lineCount(workbench.draft)} lines ·{" "}
                {workbench.draft.length} chars
              </span>
            </p>
            <Notice className="zhs-edit-workbench__banner" variant={banner.variant}>
              {banner.content}
              {sourceConfirmation !== null ? (
                <span className="zhs-edit-workbench__banner-actions">
                  <Button size="sm" variant="danger" onClick={() => void resolveSource(true)}>
                    Load v{sourceConfirmation.version}
                  </Button>
                  <Button size="sm" onClick={() => void resolveSource(false)}>
                    Keep my draft
                  </Button>
                </span>
              ) : null}
            </Notice>
          </div>
          <Textarea
            aria-label="Draft body"
            className="zhs-edit-workbench__editor"
            disabled={completionPending}
            spellCheck={false}
            value={workbench.draft}
            onChange={(event) => handleDraftChange(event.currentTarget.value)}
          />
        </section>

        <section
          className="zhs-edit-workbench__pane zhs-edit-workbench__pane--diff"
          aria-label="Live candidate diff"
          hidden={!showDiff}
        >
          <div className="zhs-edit-workbench__pane-heading">
            <p className="zhs-edit-workbench__pane-title">
              <strong>Live candidate diff</strong>
              <span>{comparison} → draft · updated as you type</span>
            </p>
          </div>
          <div
            className="zhs-edit-workbench__diff-region"
            ref={diffRegionRef}
            onScrollCapture={handleDiffScroll}
          >
            {workbench.displayDiffPending ? (
              <Notice>Updating candidate diff…</Notice>
            ) : workbench.displayDiff.model ? (
              <DiffPane
                fromLabel={comparison}
                layout={preferences.effectiveLayout}
                marks={preferences.marks}
                model={workbench.displayDiff.model}
                toLabel="draft"
                wrap={preferences.wrap}
              />
            ) : workbench.displayDiff.oversized ? (
              <Notice variant="warning">
                This local diff is too large or complex to preview. Saving remains available.
              </Notice>
            ) : (
              <Notice>The draft matches {comparison}; there are no visible line changes.</Notice>
            )}
          </div>
        </section>
      </div>

      {hasErrors ? (
        <div className="zhs-edit-workbench__errors">
          {workbench.sourceError ? (
            <ErrorBanner error={workbench.sourceError} title="Could not load editor source" />
          ) : null}
          {workbench.comparisonError ? (
            <ErrorBanner error={workbench.comparisonError} title="Could not load comparison" />
          ) : null}
          {workbench.historyError ? (
            <ErrorBanner
              error={workbench.historyError}
              onRetry={() => void workbench.reloadHistory()}
              title="Could not refresh history"
            />
          ) : null}
        </div>
      ) : null}

      <SaveReviewDialog
        draft={workbench.draft}
        head={head}
        lineEnding={workbench.lineEnding}
        machine={dialogMachine}
        open={dialogOpen}
        onClose={closeDialog}
        onDiscard={() => {
          closeDialog();
          handleDiscard();
        }}
        onSaved={(completion) => void handleSaved(completion)}
      />
    </section>
  );
}

/** Router-free editing surface. Data reads begin only after write capability resolves true. */
export function EditWorkbench(props: EditWorkbenchProps) {
  const capability = useCanWrite(props.stash);
  const me = useMe();

  if (!capability.ready) {
    return (
      <Gate path={props.path}>
        <Notice>Checking write access…</Notice>
      </Gate>
    );
  }

  if (me.error !== null) {
    return (
      <Gate path={props.path}>
        <ErrorBanner error={me.error} title="Could not verify write access" />
      </Gate>
    );
  }

  if (!capability.canWrite) {
    return (
      <Gate path={props.path}>
        <Notice variant="warning">
          <strong>Editing is not available</strong>
          <span>This credential does not have write access to {props.stash}.</span>
        </Notice>
      </Gate>
    );
  }

  return <EditWorkbenchAllowed {...props} />;
}
