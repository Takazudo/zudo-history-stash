const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const absoluteFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function relativeValue(timestamp: number, now: number): [number, Intl.RelativeTimeFormatUnit] {
  const seconds = Math.round((timestamp - now) / 1_000);
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return [seconds, "second"];
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return [minutes, "minute"];
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return [hours, "hour"];
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return [days, "day"];
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return [months, "month"];
  return [Math.round(days / 365), "year"];
}

export interface RelativeTimeProps {
  value: string;
  now?: number;
}

export function RelativeTime({ value, now = Date.now() }: RelativeTimeProps) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return <span className="zhs-relative-time">{value}</span>;
  const absolute = absoluteFormatter.format(timestamp);
  const [amount, unit] = relativeValue(timestamp, now);
  return (
    <time
      className="zhs-relative-time"
      dateTime={new Date(timestamp).toISOString()}
      title={absolute}
    >
      {relativeFormatter.format(amount, unit)}
    </time>
  );
}
