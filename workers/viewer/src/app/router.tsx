import { createBrowserRouter, Outlet, RouterProvider, type RouteObject } from "react-router-dom";
import DiffPage from "../pages/diff.js";
import EditPage from "../pages/edit.js";
import FilePage from "../pages/file.js";
import HomePage from "../pages/home.js";
import LoginPage from "../pages/login.js";
import NewFilePage from "../pages/new-file.js";
import ProposalPage from "../pages/proposal.js";
import ProposalsPage from "../pages/proposals.js";
import StashPage from "../pages/stash.js";
import TokensPage from "../pages/tokens.js";
import { RequireToken } from "./auth/require-token.js";
import { StashClientProvider } from "./auth/stash-client-provider.js";
import { AppShell } from "./shell/app-shell.js";
import { ViewerStashUiProvider } from "./viewer-stash-ui-provider.js";

function ProviderLayout() {
  return (
    <StashClientProvider>
      <Outlet />
    </StashClientProvider>
  );
}

function ProtectedLayout() {
  return (
    <RequireToken>
      <ViewerStashUiProvider>
        <AppShell />
      </ViewerStashUiProvider>
    </RequireToken>
  );
}

export const VIEWER_ROUTE_PATHS = [
  "/login",
  "/",
  "/s/:stash",
  "/s/:stash/f/*",
  "/s/:stash/diff/*",
  "/s/:stash/edit/*",
  "/s/:stash/proposals",
  "/s/:stash/proposals/:id",
  "/s/:stash/new",
  "/s/:stash/tokens",
] as const;

export const viewerRoutes: RouteObject[] = [
  {
    element: <ProviderLayout />,
    children: [
      { path: "/login", element: <LoginPage /> },
      {
        element: <ProtectedLayout />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/s/:stash", element: <StashPage /> },
          { path: "/s/:stash/f/*", element: <FilePage /> },
          { path: "/s/:stash/diff/*", element: <DiffPage /> },
          { path: "/s/:stash/edit/*", element: <EditPage />, handle: { liveAccess: "write" } },
          { path: "/s/:stash/proposals", element: <ProposalsPage /> },
          { path: "/s/:stash/proposals/:id", element: <ProposalPage /> },
          { path: "/s/:stash/new", element: <NewFilePage />, handle: { liveAccess: "write" } },
          { path: "/s/:stash/tokens", element: <TokensPage />, handle: { liveAccess: "admin" } },
        ],
      },
    ],
  },
];

export function createViewerRouter() {
  return createBrowserRouter(viewerRoutes);
}

const browserRouter = createViewerRouter();

export function ViewerApp() {
  return <RouterProvider router={browserRouter} />;
}
