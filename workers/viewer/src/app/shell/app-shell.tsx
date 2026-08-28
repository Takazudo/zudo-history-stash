import type { MeResponse } from "@takazudo/zudo-history-stash-core";
import type { ReactNode } from "react";
import { Outlet, useMatches, useParams } from "react-router-dom";
import { useMe } from "../auth/use-me.js";
import { ViewerLiveUpdatesProvider, useViewerLiveStatus } from "../live-updates.js";
import { Badge } from "./badge.js";
import { Header } from "./header.js";

type ViewerLiveAccess = "read" | "write" | "admin";

function hasLiveAccess(me: MeResponse, stash: string, required: ViewerLiveAccess): boolean {
  if (me.principal === "admin") return true;
  if (required === "admin" || me.stash !== stash) return false;
  return required === "read" || me.scope === "write";
}

function AppShellFrame({ status }: { status: ReactNode }) {
  const { stash } = useParams();
  const live = useViewerLiveStatus();

  return (
    <div className="app-shell">
      <Header
        breadcrumb={stash}
        liveStatus={stash === undefined ? undefined : live.status}
        status={status}
      />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

export function AppShell() {
  const { stash } = useParams();
  const matches = useMatches();
  const me = useMe();
  const leafHandle = matches.at(-1)?.handle as { liveAccess?: ViewerLiveAccess } | undefined;
  const requiredLiveAccess = leafHandle?.liveAccess ?? "read";
  const liveEnabled =
    stash !== undefined && me.status === "ready" && hasLiveAccess(me.me, stash, requiredLiveAccess);
  const status =
    me.status === "ready" ? (
      <Badge tone="success">{me.me.principal === "admin" ? "admin" : me.me.scope}</Badge>
    ) : me.status === "error" ? (
      <Badge tone="error">offline</Badge>
    ) : (
      <Badge>checking</Badge>
    );

  return (
    <ViewerLiveUpdatesProvider enabled={liveEnabled}>
      <AppShellFrame status={status} />
    </ViewerLiveUpdatesProvider>
  );
}
