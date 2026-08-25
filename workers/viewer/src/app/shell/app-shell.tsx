import { Outlet, useParams } from "react-router-dom";
import { useMe } from "../auth/use-me.js";
import { Badge } from "./badge.js";
import { Header } from "./header.js";

export function AppShell() {
  const { stash } = useParams();
  const me = useMe();
  const status =
    me.status === "ready" ? (
      <Badge tone="success">{me.me.principal === "admin" ? "admin" : me.me.scope}</Badge>
    ) : me.status === "error" ? (
      <Badge tone="error">offline</Badge>
    ) : (
      <Badge>checking</Badge>
    );

  return (
    <div className="app-shell">
      <Header breadcrumb={stash} status={status} />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
