import { createBrowserRouter, Outlet, RouterProvider, type RouteObject } from "react-router-dom";
import DiffPage from "../pages/diff.js";
import FilePage from "../pages/file.js";
import HomePage from "../pages/home.js";
import LoginPage from "../pages/login.js";
import StashPage from "../pages/stash.js";
import { RequireToken } from "./auth/require-token.js";
import { StashClientProvider } from "./auth/stash-client-provider.js";
import { AppShell } from "./shell/app-shell.js";

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
      <AppShell />
    </RequireToken>
  );
}

export const VIEWER_ROUTE_PATHS = [
  "/login",
  "/",
  "/s/:stash",
  "/s/:stash/f/*",
  "/s/:stash/diff/*",
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
