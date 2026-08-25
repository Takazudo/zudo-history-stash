import { render } from "@testing-library/react";
import { createMemoryRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { RequireToken } from "../app/auth/require-token.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import HomePage from "../pages/home.js";
import LoginPage from "../pages/login.js";
import StashPage from "../pages/stash.js";

export function renderViewerRoute(
  initialEntry: string,
  client: ViewerStashClient,
  options: { authenticated?: boolean } = {},
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
                <Outlet />
              </RequireToken>
            ),
            children: [
              { path: "/", element: <HomePage /> },
              { path: "/s/:stash", element: <StashPage /> },
            ],
          },
          { path: "*", element: <Navigate replace to="/" /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}
