import {
  StashError,
  ifNoneMatchMatches,
  validatePath,
  type ByteRange,
} from "@takazudo/zudo-history-stash-core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.js";
import { createStashStore } from "../d1/store.js";

const rawContent = new Hono<AppEnv>();
const INTEGER = /^(0|[1-9]\d*)$/;
const DIGITS = /^\d+$/;

function rawPath(c: Context<AppEnv>): string {
  const path = c.req.param("path");
  if (path === undefined) throw new StashError("invalid-path", "Invalid file path.");
  const result = validatePath(path);
  if (!result.ok) throw new StashError(result.error, result.message);
  return path;
}

function historicalVersion(c: Context<AppEnv>): number {
  const value = c.req.param("version");
  const version = value !== undefined && INTEGER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new StashError("version-not-found", "Version not found.");
  }
  return version;
}

function quotedEtag(etag: string): string {
  return `"${etag}"`;
}

function validContentType(value: string): string {
  const trimmed = value.trim();
  const safe = Array.from(trimmed).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return trimmed !== "" && safe ? trimmed : "application/octet-stream";
}

function extendedFilename(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`,
  );
}

/** Builds an attachment-only disposition without reflecting unsafe filename bytes. */
export function contentDisposition(path: string): string {
  const basename = path.split(/[\\/]/).at(-1) ?? "";
  const clean = Array.from(basename)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  const fallback = clean
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 180);
  const safeFallback = fallback === "" ? "download" : fallback;
  const extended = clean === "" ? safeFallback : Array.from(clean).slice(0, 180).join("");
  return `attachment; filename="${safeFallback}"; filename*=UTF-8''${extendedFilename(extended)}`;
}

/** Parses exactly one satisfiable byte range, clamping a closed end to the object size. */
export function parseByteRange(value: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0 || value.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (match === null) return null;
  const left = match[1] ?? "";
  const right = match[2] ?? "";
  if (left === "" && right === "") return null;

  if (left === "") {
    if (!DIGITS.test(right)) return null;
    const suffix = BigInt(right);
    if (suffix < 1n) return null;
    return { start: suffix >= BigInt(size) ? 0 : size - Number(suffix), end: size - 1 };
  }

  if (!DIGITS.test(left)) return null;
  const startValue = BigInt(left);
  if (startValue >= BigInt(size)) return null;
  const start = Number(startValue);
  if (right === "") return { start, end: size - 1 };
  if (!DIGITS.test(right)) return null;
  const requestedEnd = BigInt(right);
  if (requestedEnd < startValue) return null;
  return {
    start,
    end: requestedEnd >= BigInt(size) ? size - 1 : Number(requestedEnd),
  };
}

function ifRangeMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return !/^W\//i.test(trimmed) && trimmed === etag;
}

function commonHeaders(input: {
  etag: string;
  version: number;
  contentType: string;
  contentLength: number;
  path: string;
  range?: ByteRange;
  totalSize: number;
}): Headers {
  const headers = new Headers({
    ETag: input.etag,
    "X-Stash-Version": String(input.version),
    "Accept-Ranges": "bytes",
    "Content-Length": String(input.contentLength),
    "Content-Type": validContentType(input.contentType),
    "Content-Disposition": contentDisposition(input.path),
    "X-Content-Type-Options": "nosniff",
  });
  if (input.range !== undefined) {
    headers.set(
      "Content-Range",
      `bytes ${input.range.start}-${input.range.end}/${input.totalSize}`,
    );
  }
  return headers;
}

function rangeError(c: Context<AppEnv>, size: number): Response {
  const payload = JSON.stringify({
    error: { code: "range-not-satisfiable", message: "The byte range is not satisfiable." },
  });
  return new Response(c.req.method === "HEAD" ? null : payload, {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${size}`,
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Length": String(new TextEncoder().encode(payload).byteLength),
    },
  });
}

async function serve(c: Context<AppEnv>, version: number | undefined): Promise<Response> {
  const stash = c.get("routeStash").name;
  const path = rawPath(c);
  const reads = createStashStore(c.env).reads;
  const source = await reads.getFileSource(stash, path, version === undefined ? {} : { version });
  if (source === null) {
    throw new StashError(
      version === undefined ? "not-found" : "version-not-found",
      version === undefined ? "File not found." : "Version not found.",
    );
  }
  const metadata = source.metadata;
  if (metadata.deleted) throw new StashError("file-deleted", "The file version is deleted.");
  if (metadata.etag === null) throw new StashError("internal", "Stored content has no validator.");

  const etag = quotedEtag(metadata.etag);
  const baseHeaders = commonHeaders({
    etag,
    version: metadata.version,
    contentType: metadata.contentType,
    contentLength: metadata.size,
    path,
    totalSize: metadata.size,
  });
  if (ifNoneMatchMatches(c.req.header("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const rangeHeader = c.req.header("Range");
  let range: ByteRange | undefined;
  if (rangeHeader !== undefined && ifRangeMatches(c.req.header("If-Range"), etag)) {
    range = parseByteRange(rangeHeader, metadata.size) ?? undefined;
    if (range === undefined) return rangeError(c, metadata.size);
  }

  const object = await reads.getByteObject(source, range);
  const headers = commonHeaders({
    etag,
    version: metadata.version,
    contentType: object.contentType,
    contentLength: range === undefined ? metadata.size : range.end - range.start + 1,
    path,
    range,
    totalSize: metadata.size,
  });
  const isHead = c.req.method === "HEAD";
  if (isHead) await object.stream.cancel().catch(() => undefined);
  return new Response(isHead ? null : object.stream, {
    status: range === undefined ? 200 : 206,
    headers,
  });
}

rawContent.on(["GET", "HEAD"], "/v1/stashes/:stash/raw/:path{.+}", (c) => serve(c, undefined));
rawContent.on(["GET", "HEAD"], "/v1/stashes/:stash/versions/:version/raw/:path{.+}", (c) =>
  serve(c, historicalVersion(c)),
);

export default rawContent;
