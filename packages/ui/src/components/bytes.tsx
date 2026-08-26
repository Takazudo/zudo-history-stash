const byteFormatter = new Intl.NumberFormat("en");

export interface BytesProps {
  value: number;
}

export function Bytes({ value }: BytesProps) {
  const bytes = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return (
    <span className="zhs-bytes" title={`${byteFormatter.format(bytes)} bytes`}>
      {byteFormatter.format(bytes)} B
    </span>
  );
}
