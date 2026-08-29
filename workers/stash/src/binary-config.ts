import {
  D1_INLINE_MAX_BYTES,
  D1_INLINE_MAX_BYTES_CEILING,
  DIFF_MAX_BYTES,
  HTTP_REQUEST_MAX_BYTES,
  JSON_INLINE_MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_BYTES_CEILING,
  MAX_MULTIPART_PARTS,
  MAX_OPEN_UPLOAD_SESSIONS,
  MAX_RESERVED_UPLOAD_BYTES,
  MULTIPART_PART_BYTES,
  MULTIPART_PRODUCTION_MIN_PART_BYTES,
  SINGLE_UPLOAD_MAX_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  type CapabilitiesResponse,
} from "@takazudo/zudo-history-stash-core";
import type { Env } from "./env.js";

export interface BinarySettings {
  jsonInlineMaxBytes: number;
  d1InlineMaxBytes: number;
  httpRequestMaxBytes: number;
  singleUploadMaxBytes: number;
  maxFileBytes: number;
  diffMaxBytes: number;
  multipartPartBytes: number;
  maxOpenUploadSessions: number;
  maxReservedUploadBytes: number;
  uploadSessionTtlSeconds: number;
}

export type BinarySettingOverrides = Partial<BinarySettings>;

const DEFAULTS: BinarySettings = {
  jsonInlineMaxBytes: JSON_INLINE_MAX_BYTES,
  d1InlineMaxBytes: D1_INLINE_MAX_BYTES,
  httpRequestMaxBytes: HTTP_REQUEST_MAX_BYTES,
  singleUploadMaxBytes: SINGLE_UPLOAD_MAX_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  diffMaxBytes: DIFF_MAX_BYTES,
  multipartPartBytes: MULTIPART_PART_BYTES,
  maxOpenUploadSessions: MAX_OPEN_UPLOAD_SESSIONS,
  maxReservedUploadBytes: MAX_RESERVED_UPLOAD_BYTES,
  uploadSessionTtlSeconds: UPLOAD_SESSION_TTL_SECONDS,
};

const ENV_NAMES = {
  jsonInlineMaxBytes: "JSON_INLINE_MAX_BYTES",
  d1InlineMaxBytes: "D1_INLINE_MAX_BYTES",
  httpRequestMaxBytes: "HTTP_REQUEST_MAX_BYTES",
  singleUploadMaxBytes: "SINGLE_UPLOAD_MAX_BYTES",
  maxFileBytes: "MAX_FILE_BYTES",
  diffMaxBytes: "DIFF_MAX_BYTES",
  multipartPartBytes: "MULTIPART_PART_BYTES",
  maxOpenUploadSessions: "MAX_OPEN_UPLOAD_SESSIONS",
  maxReservedUploadBytes: "MAX_RESERVED_UPLOAD_BYTES",
  uploadSessionTtlSeconds: "UPLOAD_SESSION_TTL_SECONDS",
} as const satisfies Record<keyof BinarySettings, keyof Env>;

function parseInteger(name: string, source: string | undefined, fallback: number): number {
  const normalized = source === undefined || source === "" ? String(fallback) : source;
  const value = Number(normalized);
  if (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Parses deployment policy once per request/operation. `overrides` are an explicit test seam; only
 * an injected multipart size may be below R2's 5 MiB production minimum.
 */
export function parseBinarySettings(
  env: Pick<Env, (typeof ENV_NAMES)[keyof typeof ENV_NAMES]>,
  overrides: BinarySettingOverrides = {},
): BinarySettings {
  const settings = Object.fromEntries(
    Object.entries(ENV_NAMES).map(([key, name]) => {
      const typedKey = key as keyof BinarySettings;
      return [
        typedKey,
        overrides[typedKey] ?? parseInteger(name, env[name] as string, DEFAULTS[typedKey]),
      ];
    }),
  ) as unknown as BinarySettings;

  for (const [key, value] of Object.entries(settings)) {
    invariant(
      Number.isSafeInteger(value) && value > 0,
      `${ENV_NAMES[key as keyof BinarySettings]} must be a positive safe integer`,
    );
  }
  invariant(
    settings.d1InlineMaxBytes <= D1_INLINE_MAX_BYTES_CEILING,
    `D1_INLINE_MAX_BYTES must be at most ${D1_INLINE_MAX_BYTES_CEILING}`,
  );
  invariant(
    settings.maxFileBytes <= MAX_FILE_BYTES_CEILING,
    `MAX_FILE_BYTES must be at most ${MAX_FILE_BYTES_CEILING}`,
  );
  invariant(
    settings.jsonInlineMaxBytes <= settings.maxFileBytes,
    "JSON_INLINE_MAX_BYTES must not exceed MAX_FILE_BYTES",
  );
  invariant(
    settings.jsonInlineMaxBytes <= settings.httpRequestMaxBytes,
    "JSON_INLINE_MAX_BYTES must not exceed HTTP_REQUEST_MAX_BYTES",
  );
  invariant(
    settings.d1InlineMaxBytes <= settings.maxFileBytes,
    "D1_INLINE_MAX_BYTES must not exceed MAX_FILE_BYTES",
  );
  invariant(
    settings.singleUploadMaxBytes <= settings.httpRequestMaxBytes,
    "SINGLE_UPLOAD_MAX_BYTES must not exceed HTTP_REQUEST_MAX_BYTES",
  );
  invariant(
    settings.singleUploadMaxBytes <= settings.maxFileBytes,
    "SINGLE_UPLOAD_MAX_BYTES must not exceed MAX_FILE_BYTES",
  );
  invariant(
    settings.multipartPartBytes <= settings.httpRequestMaxBytes,
    "MULTIPART_PART_BYTES must not exceed HTTP_REQUEST_MAX_BYTES",
  );
  invariant(
    overrides.multipartPartBytes !== undefined ||
      settings.multipartPartBytes >= MULTIPART_PRODUCTION_MIN_PART_BYTES,
    `MULTIPART_PART_BYTES must be at least ${MULTIPART_PRODUCTION_MIN_PART_BYTES} outside tests`,
  );
  invariant(
    settings.maxOpenUploadSessions <= MAX_MULTIPART_PARTS,
    `MAX_OPEN_UPLOAD_SESSIONS must be at most ${MAX_MULTIPART_PARTS}`,
  );
  invariant(
    settings.maxReservedUploadBytes >= settings.maxFileBytes,
    "MAX_RESERVED_UPLOAD_BYTES must be at least MAX_FILE_BYTES",
  );
  invariant(
    Math.ceil(settings.maxFileBytes / settings.multipartPartBytes) <= MAX_MULTIPART_PARTS,
    `MAX_FILE_BYTES requires at most ${MAX_MULTIPART_PARTS} multipart parts`,
  );
  invariant(
    settings.uploadSessionTtlSeconds <= 31_536_000,
    "UPLOAD_SESSION_TTL_SECONDS must be at most 31536000",
  );
  return Object.freeze(settings);
}

export function capabilitiesFor(settings: BinarySettings): CapabilitiesResponse {
  return {
    representations: ["text", "binary"],
    contentAccess: ["inline", "raw", "deleted"],
    transferModes: ["json", "single", "multipart"],
    storageTiers: ["d1", "r2"],
    commitEntryKinds: ["put-text", "put-binary", "copy", "delete", "rollback"],
    limits: {
      jsonInlineMaxBytes: settings.jsonInlineMaxBytes,
      d1InlineMaxBytes: settings.d1InlineMaxBytes,
      httpRequestMaxBytes: settings.httpRequestMaxBytes,
      singleUploadMaxBytes: settings.singleUploadMaxBytes,
      maxFileBytes: settings.maxFileBytes,
      diffMaxBytesPerSide: settings.diffMaxBytes,
      multipartPartBytes: settings.multipartPartBytes,
      maxMultipartParts: MAX_MULTIPART_PARTS,
      maxOpenUploadSessionsPerStash: settings.maxOpenUploadSessions,
      maxReservedUploadBytesPerStash: settings.maxReservedUploadBytes,
      uploadSessionTtlSeconds: settings.uploadSessionTtlSeconds,
    },
  };
}
