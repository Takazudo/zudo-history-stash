import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useStashClient } from "./stash-client-provider.js";

export function RequireToken({ children }: { children: ReactNode }) {
  const { token } = useStashClient();
  const location = useLocation();

  if (!token) {
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(currentUrl)}`} />;
  }

  return children;
}
