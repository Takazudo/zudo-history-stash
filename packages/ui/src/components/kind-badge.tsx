import type { VersionKind } from "@takazudo/zudo-history-stash";

const kindDetails = {
  put: { label: "put" },
  delete: { label: "delete" },
  rollback: { label: "rollback" },
} as const satisfies Record<VersionKind, { label: string }>;

function KindIcon({ kind }: { kind: VersionKind }) {
  return (
    <svg
      aria-hidden="true"
      className="zhs-kind-badge__icon"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      {kind === "put" ? <path d="M4 8h8M8 4v8" /> : null}
      {kind === "delete" ? <path d="M4 8h8" /> : null}
      {kind === "rollback" ? <path d="M6 4H3v3M3 7a5 5 0 1 1 1.5 3.5" /> : null}
    </svg>
  );
}

export interface KindBadgeProps {
  kind: VersionKind;
  rollbackOf?: number | null;
}

export function KindBadge({ kind, rollbackOf }: KindBadgeProps) {
  const details = kindDetails[kind];
  return (
    <span className={`zhs-kind-badge zhs-kind-badge--${kind}`}>
      <KindIcon kind={kind} />
      <span>{details.label}</span>
      {kind === "rollback" && rollbackOf != null ? <span>→ v{rollbackOf}</span> : null}
    </span>
  );
}
