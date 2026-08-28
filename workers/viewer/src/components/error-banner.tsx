import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ErrorBanner as PackageErrorBanner,
  type ErrorBannerProps,
} from "@takazudo/zudo-history-stash-ui";
import { StashHttpError, type ClientResult } from "@takazudo/zudo-history-stash";
import { useStashClient } from "../app/auth/stash-client-provider.js";

export interface ErrorDetails {
  status?: number;
  code?: string;
  message: string;
}

function isFailure(value: unknown): value is Extract<ClientResult<unknown>, { ok: false }> {
  return Boolean(
    value && typeof value === "object" && "ok" in value && value.ok === false && "error" in value,
  );
}

export function stashErrorDetails(value: unknown): ErrorDetails {
  if (isFailure(value)) return value.error;
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
    return { status: value.status, code: value.code, message };
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
  if (details.code === "exists") return "A stash with that name already exists.";
  return details.message;
}

export async function clientValue<T>(request: Promise<ClientResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw result;
  return result.value;
}

export type { ErrorBannerProps };

/** Keep credential clearing and deep-link redirects in the Viewer host, never in package UI. */
export function ErrorBanner(props: ErrorBannerProps) {
  const details = stashErrorDetails(props.error);
  const { logOut } = useStashClient();
  const location = useLocation();
  const navigate = useNavigate();
  const unauthorized = details.status === 401 || details.code === "unauthorized";

  useEffect(() => {
    if (!unauthorized) return;
    const next = `${location.pathname}${location.search}${location.hash}`;
    logOut();
    navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [location.hash, location.pathname, location.search, logOut, navigate, unauthorized]);

  return <PackageErrorBanner {...props} />;
}
