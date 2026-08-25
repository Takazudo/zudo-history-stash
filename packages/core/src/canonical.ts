export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key] as JsonValue)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export type WriteOperation = "put" | "delete" | "rollback";

export interface RequestHashParams {
  path: string;
  expectedVersion: number | null;
  bodyHash?: string | null;
  contentType?: string;
  toVersion?: number | null;
  author?: string;
  message?: string;
  meta?: { [key: string]: JsonValue };
  skipIfUnchanged?: boolean;
}

export function requestHashInput(op: WriteOperation, params: RequestHashParams): JsonValue {
  return {
    op,
    path: params.path,
    expectedVersion: params.expectedVersion,
    bodyHash: params.bodyHash ?? null,
    contentType: params.contentType ?? "text/plain; charset=utf-8",
    toVersion: params.toVersion ?? null,
    author: params.author ?? "",
    message: params.message ?? "",
    meta: params.meta ?? {},
    skipIfUnchanged: params.skipIfUnchanged ?? false,
  };
}
