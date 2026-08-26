import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ErrorBanner as RelocatedErrorBanner,
  stashErrorDetails,
  type ErrorBannerProps,
} from "../../../../packages/ui/src/components/relocated.js";
import { useStashClient } from "../app/auth/stash-client-provider.js";

export {
  clientValue,
  stashErrorMessage,
} from "../../../../packages/ui/src/components/relocated.js";
export { stashErrorDetails } from "../../../../packages/ui/src/components/relocated.js";
export type {
  ErrorBannerProps,
  ErrorDetails,
} from "../../../../packages/ui/src/components/relocated.js";

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

  return <RelocatedErrorBanner {...props} />;
}
