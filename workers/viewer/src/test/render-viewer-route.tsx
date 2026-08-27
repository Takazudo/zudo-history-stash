import { render } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import {
  createMemoryRouter,
  type InitialEntry,
  Navigate,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { RequireToken } from "../app/auth/require-token.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { ViewerStashUiProvider } from "../app/viewer-stash-ui-provider.js";
import HomePage from "../pages/home.js";
import LoginPage from "../pages/login.js";
import ProposalPage from "../pages/proposal.js";
import ProposalsPage from "../pages/proposals.js";
import StashPage from "../pages/stash.js";

export function renderViewerRoute(
  initialEntry: InitialEntry,
  client: ViewerStashClient,
  options: { authenticated?: boolean; strict?: boolean } = {},
) {
  if (options.authenticated !== false) sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
  const clientFactory: ViewerStashClientFactory = () => client;
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <Outlet />
          </StashClientProvider>
        ),
        children: [
          { path: "/login", element: <LoginPage /> },
          {
            element: (
              <RequireToken>
                <ViewerStashUiProvider>
                  <Outlet />
                </ViewerStashUiProvider>
              </RequireToken>
            ),
            children: [
              { path: "/", element: <HomePage /> },
              { path: "/s/:stash", element: <StashPage /> },
              { path: "/s/:stash/proposals", element: <ProposalsPage /> },
              { path: "/s/:stash/proposals/:id", element: <ProposalPage /> },
            ],
          },
          { path: "*", element: <Navigate replace to="/" /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const provider = <RouterProvider router={router} />;
  const tree: ReactElement = options.strict ? <StrictMode>{provider}</StrictMode> : provider;
  return { router, ...render(tree) };
}
