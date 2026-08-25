import type { VersionKind } from "@takazudo/zudo-history-stash";

const kindDetails = {
  put: { glyph: "+", label: "put" },
  delete: { glyph: "−", label: "delete" },
  rollback: { glyph: "↩", label: "rollback" },
} as const satisfies Record<VersionKind, { glyph: string; label: string }>;

export function KindBadge({ kind, rollbackOf }: { kind: VersionKind; rollbackOf?: number | null }) {
  const details = kindDetails[kind];
  return (
    <span className={`kind-badge kind-badge--${kind}`}>
      <span aria-hidden="true">{details.glyph}</span>
      <span>{details.label}</span>
      {kind === "rollback" && rollbackOf ? <span>→ v{rollbackOf}</span> : null}
    </span>
  );
}
