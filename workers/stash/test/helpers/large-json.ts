const CHUNK_BYTES = 32 * 1_024;
const encoder = new TextEncoder();

type AsciiPart = string | { unit: string; count: number };

export interface EncodedRequest {
  body: ReadableStream<Uint8Array>;
  byteLength: number;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function byteLength(parts: readonly AsciiPart[]): number {
  return parts.reduce((total, part) => {
    if (typeof part === "string") return total + encoder.encode(part).byteLength;
    return total + encoder.encode(part.unit).byteLength * part.count;
  }, 0);
}

function encodedAscii(parts: readonly AsciiPart[]): EncodedRequest {
  const totalBytes = byteLength(parts);
  let partIndex = 0;
  let repeated = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      for (;;) {
        const part = parts[partIndex];
        if (part === undefined) {
          controller.close();
          return;
        }

        if (typeof part === "string") {
          partIndex += 1;
          if (part.length === 0) continue;
          const chunk = encoder.encode(part);
          if (chunk.byteLength > CHUNK_BYTES) {
            throw new Error("Literal fixture scaffolding exceeds the chunk size");
          }
          controller.enqueue(chunk);
          return;
        }

        const remaining = part.count - repeated;
        if (remaining === 0) {
          partIndex += 1;
          repeated = 0;
          continue;
        }
        const unitBytes = encoder.encode(part.unit).byteLength;
        const units = Math.min(remaining, Math.max(1, Math.floor(CHUNK_BYTES / unitBytes)));
        controller.enqueue(encoder.encode(part.unit.repeat(units)));
        repeated += units;
        return;
      }
    },
  });

  return { body, byteLength: totalBytes };
}

export function repeatedAsciiRequest(byteLength: number): EncodedRequest {
  assertNonNegativeInteger(byteLength, "byteLength");
  return encodedAscii([{ unit: "x", count: byteLength }]);
}

export function escapedPutRequest(decodedBytes: number): EncodedRequest {
  assertNonNegativeInteger(decodedBytes, "decodedBytes");
  return encodedAscii([
    '{"body":"',
    { unit: "\\u0001", count: decodedBytes },
    '","expectedVersion":null}',
  ]);
}

export function escapedImportRequest(
  entries: number,
  decodedBytesPerEntry: number,
): EncodedRequest {
  assertNonNegativeInteger(entries, "entries");
  assertNonNegativeInteger(decodedBytesPerEntry, "decodedBytesPerEntry");
  if (entries < 1) throw new Error("entries must be positive");
  if (decodedBytesPerEntry < 1) throw new Error("decodedBytesPerEntry must be positive");
  if (entries > 10) throw new Error("The fixture needs one distinct decimal suffix per entry");

  const parts: AsciiPart[] = ['{"path":"history.txt","expectedVersion":null,"versions":['];
  for (let index = 0; index < entries; index += 1) {
    if (index > 0) parts.push(",");
    parts.push(
      '{"kind":"put","body":"',
      { unit: "\\u0001", count: decodedBytesPerEntry - 1 },
      String(index),
      `","createdAt":${1_000 + index}}`,
    );
  }
  parts.push("]}");
  return encodedAscii(parts);
}
