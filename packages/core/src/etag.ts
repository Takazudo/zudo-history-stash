export type EtagSource =
  | { version: number; hash: string; deleted: false }
  | { version: number; hash: null; deleted: true };

export function formatEtag(source: EtagSource): string {
  return `"v${source.version}-${source.deleted ? "deleted" : source.hash}"`;
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//i, "");
}

export function ifNoneMatchMatches(headerValue: string | null | undefined, etag: string): boolean {
  if (headerValue == null) return false;
  return headerValue.split(",").some((candidate) => {
    const normalized = normalizeEtag(candidate);
    return normalized === "*" || normalized === normalizeEtag(etag);
  });
}
