import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ui from "./index.js";

const PUBLIC_RUNTIME_EXPORTS = [
  "Button",
  "Bytes",
  "ChangeRow",
  "CreateStashDialog",
  "DeleteFileDialog",
  "DeleteStashDialog",
  "Dialog",
  "DiffControls",
  "DiffPane",
  "EditWorkbench",
  "ErrorBanner",
  "HistoryList",
  "HistoryRail",
  "GcPanel",
  "Input",
  "KindBadge",
  "LiveIndicator",
  "LoadMore",
  "NewFileForm",
  "Notice",
  "PathCell",
  "ProposalList",
  "ProposalReview",
  "ApproveProposalDialog",
  "RejectProposalDialog",
  "RelativeTime",
  "RollbackDialog",
  "SaveReviewDialog",
  "Select",
  "SplitDiffTable",
  "SrOnly",
  "StashUiProvider",
  "Table",
  "TableBody",
  "TableCaption",
  "TableCell",
  "TableFoot",
  "TableHead",
  "TableHeader",
  "TableRow",
  "Textarea",
  "TokensPanel",
  "TombstoneRestore",
  "VERSION",
  "defaultStashHref",
  "defaultStashHrefFor",
  "clearWorkbenchDraftsForCredentialChange",
  "createRefreshScheduler",
  "useCanWrite",
  "useCandidateDiff",
  "useDiffViewPreferences",
  "useFileHistory",
  "useIdempotencyKey",
  "useIsAdmin",
  "useLiveChanges",
  "useMediaQuery",
  "useSaveMachine",
  "useStashClient",
  "useStashClientForSignal",
  "useStashHref",
  "useWorkbench",
] as const;

const PUBLIC_TYPE_EXPORTS = [
  "ButtonProps",
  "ButtonSize",
  "ButtonVariant",
  "BytesProps",
  "CanWriteState",
  "CandidateDiff",
  "CandidateDiffOptions",
  "ChangeRowProps",
  "CreateStashDialogProps",
  "DeleteFileDialogProps",
  "DeleteStashDialogProps",
  "DialogProps",
  "DiffControlsProps",
  "DiffPaneLayout",
  "DiffPaneProps",
  "DiffViewLayout",
  "DiffViewPreferences",
  "EditWorkbenchLiveRefresh",
  "EditWorkbenchLiveRefreshOptions",
  "EditWorkbenchProps",
  "EditWorkbenchSaved",
  "ErrorBannerProps",
  "ErrorDetails",
  "FileHistoryState",
  "HistoryListProps",
  "HistoryRailProps",
  "GcPanelProps",
  "InputProps",
  "IsAdminState",
  "KindBadgeProps",
  "LineEnding",
  "LiveChangesStatus",
  "LiveIndicatorProps",
  "LiveRefreshReason",
  "LiveRefreshRequest",
  "LoadMoreProps",
  "NewFileCreated",
  "NewFileFormProps",
  "NoticeProps",
  "NoticeVariant",
  "PathCellProps",
  "ProposalListProps",
  "ProposalReviewProps",
  "ApproveProposalDialogProps",
  "RejectProposalDialogProps",
  "RelativeTimeProps",
  "RefreshScheduler",
  "RefreshTask",
  "RollbackDialogProps",
  "RollbackSuccess",
  "SaveMachine",
  "SaveHeadVerificationOutcome",
  "SaveMachineOptions",
  "SaveMachineState",
  "SaveMetadata",
  "SaveReviewCompletion",
  "SaveReviewDialogProps",
  "SelectProps",
  "SourceLoadResult",
  "SplitDiffTableProps",
  "SrOnlyProps",
  "StashAnchorComponent",
  "StashAnchorProps",
  "StashHrefFor",
  "StashMeState",
  "StashUiProviderProps",
  "StashUiRoute",
  "TextareaProps",
  "TokensPanelProps",
  "TombstoneRestoreProps",
  "UseFileHistoryOptions",
  "UseLiveChangesOptions",
  "UseLiveChangesResult",
  "UseWorkbenchOptions",
  "WorkbenchComparison",
  "WorkbenchDraftRecord",
  "WorkbenchState",
] as const;

describe("public package exports", () => {
  it("exposes only the documented runtime surface", () => {
    expect(Object.keys(ui).sort()).toEqual([...PUBLIC_RUNTIME_EXPORTS].sort());
  });

  it("pins the documented type-only surface", () => {
    const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
    const exportedTypes = [...source.matchAll(/export\s+type\s*\{([\s\S]*?)\}\s+from/gu)]
      .flatMap((match) => match[1]?.split(",") ?? [])
      .map((name) => name.trim())
      .filter(Boolean);

    // Route types stay public so hosts can implement hrefFor and Anchor without importing
    // package internals; the package itself remains independent of any router.
    expect(exportedTypes.sort()).toEqual([...PUBLIC_TYPE_EXPORTS].sort());
  });

  it("pins the complete deterministic stylesheet entry", () => {
    const sourceRoot = resolve(process.cwd(), "src");
    const imports = [
      ...readFileSync(resolve(sourceRoot, "styles/index.css"), "utf8").matchAll(
        /@import\s+"([^"]+)";/gu,
      ),
    ].map((match) => match[1]);
    const expected = [
      "./primitives.css",
      "./relocated.css",
      "./stateful.css",
      "./tokens-panel.css",
      "../components/create-stash-dialog.css",
      "../components/delete-file-dialog.css",
      "../components/delete-stash-dialog.css",
      "../components/edit-workbench.css",
      "../components/history-rail.css",
      "../components/live-indicator.css",
      "../components/gc-panel.css",
      "../components/new-file-form.css",
      "../components/proposal.css",
      "../components/save-review-dialog.css",
      "../components/tombstone-restore.css",
    ];
    const discovered = [
      ...readdirSync(resolve(sourceRoot, "styles"))
        .filter((file) => file.endsWith(".css") && file !== "index.css")
        .map((file) => `./${file}`),
      ...readdirSync(resolve(sourceRoot, "components"))
        .filter((file) => file.endsWith(".css"))
        .map((file) => `../components/${file}`),
    ];

    expect(imports).toEqual(expected);
    expect([...imports].sort()).toEqual(discovered.sort());
  });
});
