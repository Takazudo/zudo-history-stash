/** Package version exposed for diagnostics and release compatibility checks. */
export const VERSION = "0.0.0";

export { StashUiProvider } from "./provider/stash-ui-provider.js";
export { defaultStashHref, defaultStashHrefFor } from "./provider/routes.js";
export {
  useCanWrite,
  useIsAdmin,
  useStashClient,
  useStashClientForSignal,
  useStashHref,
} from "./provider/hooks.js";

export { useCandidateDiff } from "./hooks/use-candidate-diff.js";
export { useDiffViewPreferences } from "./hooks/use-diff-view-preferences.js";
export { useFileHistory } from "./hooks/use-file-history.js";
export { useIdempotencyKey } from "./hooks/use-idempotency-key.js";
export { useMediaQuery } from "./hooks/use-media-query.js";
export { useSaveMachine } from "./hooks/use-save-machine.js";
export { clearWorkbenchDraftsForCredentialChange, useWorkbench } from "./hooks/use-workbench.js";

export { Bytes } from "./components/bytes.js";
export { ChangeRow } from "./components/change-row.js";
export { CreateStashDialog } from "./components/create-stash-dialog.js";
export { DeleteFileDialog } from "./components/delete-file-dialog.js";
export { DeleteStashDialog } from "./components/delete-stash-dialog.js";
export { DiffControls } from "./components/diff-controls.js";
export { DiffPane } from "./components/diff-pane.js";
export { EditWorkbench } from "./components/edit-workbench.js";
export { ErrorBanner } from "./components/error-banner.js";
export { HistoryList } from "./components/history-list.js";
export { HistoryRail } from "./components/history-rail.js";
export { GcPanel } from "./components/gc-panel.js";
export { KindBadge } from "./components/kind-badge.js";
export { LoadMore } from "./components/load-more.js";
export { NewFileForm } from "./components/new-file-form.js";
export { PathCell } from "./components/path-cell.js";
export { RelativeTime } from "./components/relative-time.js";
export { RollbackDialog } from "./components/rollback-dialog.js";
export { SaveReviewDialog } from "./components/save-review-dialog.js";
export { SplitDiffTable } from "./components/split-diff-table.js";
export { TokensPanel } from "./components/tokens-panel.js";
export { TombstoneRestore } from "./components/tombstone-restore.js";

export {
  Button,
  Dialog,
  Input,
  Notice,
  Select,
  SrOnly,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFoot,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "./primitives/index.js";

export type { StashUiProviderProps } from "./provider/stash-ui-provider.js";
export type {
  CanWriteState,
  IsAdminState,
  StashAnchorComponent,
  StashAnchorProps,
  StashHrefFor,
  StashMeState,
  StashUiRoute,
} from "./provider/types.js";
export type { CandidateDiff, CandidateDiffOptions } from "./hooks/use-candidate-diff.js";
export type { DiffViewLayout, DiffViewPreferences } from "./hooks/use-diff-view-preferences.js";
export type { FileHistoryState, UseFileHistoryOptions } from "./hooks/use-file-history.js";
export type {
  LineEnding,
  SaveMachine,
  SaveMachineOptions,
  SaveMachineState,
  SaveMetadata,
} from "./hooks/use-save-machine.js";
export type {
  SourceLoadResult,
  UseWorkbenchOptions,
  WorkbenchComparison,
  WorkbenchDraftRecord,
  WorkbenchState,
} from "./hooks/use-workbench.js";
export type { BytesProps } from "./components/bytes.js";
export type { ChangeRowProps } from "./components/change-row.js";
export type { CreateStashDialogProps } from "./components/create-stash-dialog.js";
export type { DeleteFileDialogProps } from "./components/delete-file-dialog.js";
export type { DeleteStashDialogProps } from "./components/delete-stash-dialog.js";
export type { DiffControlsProps } from "./components/diff-controls.js";
export type { DiffPaneLayout, DiffPaneProps } from "./components/diff-pane.js";
export type { EditWorkbenchProps, EditWorkbenchSaved } from "./components/edit-workbench.js";
export type { ErrorBannerProps, ErrorDetails } from "./components/error-banner.js";
export type { HistoryListProps } from "./components/history-list.js";
export type { HistoryRailProps } from "./components/history-rail.js";
export type { GcPanelProps } from "./components/gc-panel.js";
export type { KindBadgeProps } from "./components/kind-badge.js";
export type { LoadMoreProps } from "./components/load-more.js";
export type { NewFileCreated, NewFileFormProps } from "./components/new-file-form.js";
export type { PathCellProps } from "./components/path-cell.js";
export type { RelativeTimeProps } from "./components/relative-time.js";
export type { RollbackDialogProps, RollbackSuccess } from "./components/rollback-dialog.js";
export type {
  SaveReviewCompletion,
  SaveReviewDialogProps,
} from "./components/save-review-dialog.js";
export type { SplitDiffTableProps } from "./components/split-diff-table.js";
export type { TokensPanelProps } from "./components/tokens-panel.js";
export type { TombstoneRestoreProps } from "./components/tombstone-restore.js";
export type {
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  DialogProps,
  InputProps,
  NoticeProps,
  NoticeVariant,
  SelectProps,
  SrOnlyProps,
  TextareaProps,
} from "./primitives/index.js";
