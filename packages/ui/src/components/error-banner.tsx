import { StashHttpError, type ClientResult } from "@takazudo/zudo-history-stash";
import { Button } from "../primitives/button.js";
import { Notice } from "../primitives/notice.js";

export interface ErrorDetails {
  status?: number;
  code?: string;
  message: string;
  retryAfter?: number;
  successorId?: string;
}

function isFailure(value: unknown): value is Extract<ClientResult<unknown>, { ok: false }> {
  return Boolean(
    value && typeof value === "object" && "ok" in value && value.ok === false && "error" in value,
  );
}

export function stashErrorDetails(value: unknown): ErrorDetails {
  if (isFailure(value)) {
    return {
      ...value.error,
      ...(value.retryAfter === undefined ? {} : { retryAfter: value.retryAfter }),
    };
  }
  if (value instanceof StashHttpError) {
    let message = value.message;
    if (value.body && typeof value.body === "object" && "error" in value.body) {
      const detail = value.body.error;
      if (detail && typeof detail === "object" && "message" in detail) {
        if (typeof detail.message === "string") message = detail.message;
      }
    } else if (value.cause instanceof Error) {
      message = value.cause.message;
    }
    return {
      status: value.status,
      code: value.code,
      message,
    };
  }
  if (value instanceof Error) return { message: value.message };
  return { message: "The request could not be completed." };
}

export function stashErrorMessage(value: unknown): string {
  const details = stashErrorDetails(value);
  if (details.status === 401 || details.code === "unauthorized") {
    return "That token is no longer authorized. Sign in again.";
  }
  if (details.status === 403 || details.code === "scope") {
    return "This token does not have permission for that operation.";
  }
  if (
    (details.status === 429 || details.code === "rate-limited") &&
    typeof details.retryAfter === "number" &&
    Number.isSafeInteger(details.retryAfter) &&
    details.retryAfter >= 0
  ) {
    return `Rate limited — try again in ${details.retryAfter}s`;
  }
  if (details.code === "exists") return "A stash with that name already exists.";
  return details.message;
}

export async function clientValue<T>(request: Promise<ClientResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw result;
  return result.value;
}

export interface ErrorBannerProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}

/** Pure error presentation. Hosts retain credential clearing and unauthorized navigation. */
export function ErrorBanner({
  error,
  onRetry,
  title = "Could not load this data",
}: ErrorBannerProps) {
  const details = stashErrorDetails(error);
  const unauthorized = details.status === 401 || details.code === "unauthorized";

  return (
    <Notice className="zhs-error-banner" variant="error">
      <strong>{unauthorized ? "Session expired" : title}</strong>
      <p>{stashErrorMessage(error)}</p>
      {onRetry && !unauthorized ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Notice>
  );
}
