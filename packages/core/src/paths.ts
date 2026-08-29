import { MAX_PATH_BYTES } from "./limits.js";

export type ValidationResult =
  { ok: true } | { ok: false; error: "invalid-path" | "validation"; message: string };

export interface PathPrefixRange {
  lo: string;
  hi: string;
}

export type PathPrefixRangeResult =
  | { ok: true; range: PathPrefixRange | null }
  | { ok: false; error: "invalid-path" | "validation"; message: string };

const STASH_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function validateStashName(name: string): ValidationResult {
  if (!STASH_NAME.test(name)) {
    return { ok: false, error: "validation", message: "Invalid stash name" };
  }
  return { ok: true };
}

export function validatePath(path: string): ValidationResult {
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
    return { ok: false, error: "invalid-path", message: "Path exceeds 512 UTF-8 bytes" };
  }
  const segments = path.split("/");
  if (
    path.length === 0 ||
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || !PATH_SEGMENT.test(segment),
    )
  ) {
    return { ok: false, error: "invalid-path", message: "Invalid file path" };
  }
  return { ok: true };
}

export function pathPrefixRange(prefix: string | undefined): PathPrefixRangeResult {
  if (prefix === undefined) return { ok: true, range: null };
  const path = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const result = validatePath(path);
  if (!result.ok) return result;
  // "0" (U+0030) follows "/" (U+002F), making it the exclusive descendant bound.
  return { ok: true, range: { lo: `${path}/`, hi: `${path}0` } };
}

export function joinPath(...segments: string[]): string {
  return segments.join("/");
}
