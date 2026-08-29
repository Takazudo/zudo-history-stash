export type Representation = "text" | "binary";
export type ContentAccess = "inline" | "raw" | "deleted";
export type StorageTier = "d1" | "r2";
/** Selects the immutable content table referenced by a version row. */
export type ContentStorage = "legacy" | "bytes";
export type UploadMode = "single" | "multipart";

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decodes padded RFC 4648 base64 while rejecting whitespace and non-canonical spellings. */
export function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!CANONICAL_BASE64.test(value)) throw new TypeError("Invalid canonical base64");
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    if (btoa(decoded) !== value) throw new TypeError("Invalid canonical base64");
    return bytes;
  } catch {
    throw new TypeError("Invalid canonical base64");
  }
}

export function isCanonicalBase64(value: string): boolean {
  try {
    decodeCanonicalBase64(value);
    return true;
  } catch {
    return false;
  }
}

export interface ContentMetadata {
  representation: Representation;
  contentAccess: ContentAccess;
  contentType: string;
  byteSize: number;
  /** Strong application validator: `sha256-` plus the lowercase digest of exact content bytes. */
  etag: string | null;
}

/** Fully resolved JSON content shape; `body: null` never implies deletion by itself. */
export type ResolvedContent =
  | {
      deleted: false;
      contentAccess: "inline";
      representation: "text";
      body: string;
    }
  | {
      deleted: false;
      contentAccess: "raw";
      representation: Representation;
      body: null;
    }
  | {
      deleted: true;
      contentAccess: "deleted";
      representation: Representation;
      body: null;
    };

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface ByteObject {
  stream: ReadableStream<Uint8Array>;
  size: number;
  etag: string;
  contentType: string;
  range?: ByteRange;
}

/** Read seam shared by legacy TEXT, D1 BLOB, and private R2 implementations. */
export interface ByteStorageReader {
  get(input: {
    stash: string;
    hash: string;
    storage: ContentStorage;
    size: number;
    etag: string;
    contentType: string;
    range?: ByteRange;
  }): Promise<ByteObject | null>;
}

export interface StagedByteObject {
  sessionId: string;
  generation: number;
  tier: StorageTier;
  size: number;
  hash: string;
  objectKey?: string;
}

/** Staging seam used by single and multipart upload implementations. */
export interface ByteStorageWriter {
  stage(input: {
    sessionId: string;
    generation: number;
    tier: StorageTier;
    stream: ReadableStream<Uint8Array>;
    declaredSize: number;
  }): Promise<StagedByteObject>;
  discard(staged: StagedByteObject): Promise<void>;
}
