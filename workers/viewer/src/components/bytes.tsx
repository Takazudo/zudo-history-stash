const byteFormatter = new Intl.NumberFormat("en");

export function Bytes({ value }: { value: number }) {
  const bytes = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return (
    <span className="bytes" title={`${byteFormatter.format(bytes)} bytes`}>
      {byteFormatter.format(bytes)} B
    </span>
  );
}
