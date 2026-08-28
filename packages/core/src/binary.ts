export type Representation = "text" | "binary";
export type ContentAccess = "inline" | "raw" | "deleted";
export type StorageTier = "d1" | "r2";
export type UploadMode = "single" | "multipart";

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
  get(input: { stash: string; hash: string; range?: ByteRange }): Promise<ByteObject | null>;
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
