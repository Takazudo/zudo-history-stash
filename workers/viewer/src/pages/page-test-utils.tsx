import { render } from "@testing-library/react";
import { type ReactElement } from "react";
import {
  createMemoryRouter,
  type InitialEntry,
  Outlet,
  type RouteObject,
  RouterProvider,
} from "react-router-dom";
import {
  StashClientProvider,
  type ViewerStashClient,
  type ViewerStashClientFactory,
} from "../app/auth/stash-client-provider.js";
import { RequireToken } from "../app/auth/require-token.js";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { ViewerLiveUpdatesProvider } from "../app/live-updates.js";
import { ViewerStashUiProvider } from "../app/viewer-stash-ui-provider.js";

export function renderViewerPage(
  initialEntry: InitialEntry,
  route: string,
  page: ReactElement,
  client: ViewerStashClient,
  handle?: { liveAccess: "read" | "write" | "admin" },
  additionalRoutes: RouteObject[] = [],
) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
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
          { path: "/login", element: <p>Login destination</p> },
          {
            element: (
              <RequireToken>
                <ViewerStashUiProvider>
                  <ViewerLiveUpdatesProvider>
                    <Outlet />
                  </ViewerLiveUpdatesProvider>
                </ViewerStashUiProvider>
              </RequireToken>
            ),
            children: [{ path: route, element: page, handle }, ...additionalRoutes],
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}
