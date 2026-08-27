import { classNames } from "../primitives/class-names.js";
import type { LiveChangesStatus } from "../hooks/use-live-changes.js";

const STATUS_LABEL = {
  live: "Live",
  reconnecting: "Reconnecting",
  polling: "Polling",
  off: "Off",
} as const satisfies Record<LiveChangesStatus, string>;

function LiveStatusIcon({ status }: { status: LiveChangesStatus }) {
  return (
    <svg
      aria-hidden="true"
      className="zhs-live-indicator__icon"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="square"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      {status === "live" ? (
        <>
          <circle cx="8" cy="8" r="5" />
          <path d="m5.5 8 1.5 1.5 3.5-3.5" />
        </>
      ) : null}
      {status === "reconnecting" ? (
        <>
          <path d="M12.5 6A5 5 0 0 0 4 4.5L2.5 6" />
          <path d="M2.5 3v3h3" />
          <path d="M3.5 10A5 5 0 0 0 12 11.5l1.5-1.5" />
          <path d="M13.5 13v-3h-3" />
        </>
      ) : null}
      {status === "polling" ? (
        <>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 5v3l2 1.5" />
        </>
      ) : null}
      {status === "off" ? (
        <>
          <circle cx="8" cy="8" r="5" />
          <path d="m4.5 4.5 7 7" />
        </>
      ) : null}
    </svg>
  );
}

export interface LiveIndicatorProps {
  status: LiveChangesStatus;
  className?: string;
}

/** Compact, text-labelled live transport status for a host header or page toolbar. */
export function LiveIndicator({ status, className }: LiveIndicatorProps) {
  const label = STATUS_LABEL[status];
  return (
    <span
      aria-label={`Live updates: ${label.toLowerCase()}`}
      className={classNames("zhs-live-indicator", `zhs-live-indicator--${status}`, className)}
      role="status"
    >
      <LiveStatusIcon status={status} />
      <span>{label}</span>
    </span>
  );
}
