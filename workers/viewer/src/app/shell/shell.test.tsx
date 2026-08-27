import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import type { ClientResult, MeResponse, StashEventStream } from "@takazudo/zudo-history-stash";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClientFactory,
  useStashClient,
} from "../auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "../auth/token-store.js";
import { viewerRoutes } from "../router.js";
import { ViewerStashUiProvider } from "../viewer-stash-ui-provider.js";
import { createFakeBackedViewerClient } from "../../test/fake-viewer-client.js";
import { AppShell } from "./app-shell.js";
import { Header } from "./header.js";

function renderShellRoute(
  clientFactory: ViewerStashClientFactory,
  {
    handle,
    page = <p>Route content</p>,
  }: { handle?: { liveAccess: "read" | "write" | "admin" }; page?: React.ReactNode } = {},
) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_initial");
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashClientProvider clientFactory={clientFactory}>
            <ViewerStashUiProvider>
              <AppShell />
            </ViewerStashUiProvider>
          </StashClientProvider>
        ),
        children: [{ path: "/s/:stash", element: page, handle }],
      },
    ],
    { initialEntries: ["/s/notes"] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function CredentialControls() {
  const { authenticate, logOut, token } = useStashClient();
  return (
    <>
      <button onClick={() => authenticate("zhs_replacement")}>Replace credential</button>
      <button onClick={logOut}>Control log out</button>
      <output aria-label="Active credential">{token ?? "none"}</output>
    </>
  );
}

function stubAdminApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      ).pathname;
      if (pathname === "/api/v1/me") return Response.json({ principal: "admin" });
      if (pathname === "/api/v1/stashes") {
        return Response.json({ stashes: [], nextAfter: null });
      }
      if (pathname === "/api/v1/changes") {
        return Response.json({ changes: [], hasMore: false, nextBefore: null });
      }
      return Response.json({ error: { code: "not-found", message: "Not found" } }, { status: 404 });
    }),
  );
}

it("renders the shared live status through the package indicator", () => {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <StashClientProvider>
            <Header breadcrumb="notes" liveStatus="polling" />
          </StashClientProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );

  render(<RouterProvider router={router} />);

  expect(screen.getByRole("status", { name: "Live updates: polling" })).toBeTruthy();
});

it("opens no subscription before capability resolution and exactly one after authorization", async () => {
  const fake = createFakeStash({ adminToken: "shell-live-admin" });
  fake.createStash("notes");
  let resolveMe!: (result: ClientResult<MeResponse>) => void;
  const pendingMe = new Promise<ClientResult<MeResponse>>((resolve) => {
    resolveMe = resolve;
  });
  const clientFactory: ViewerStashClientFactory = (options) => ({
    ...createFakeBackedViewerClient(fake, "shell-live-admin", options.clientId),
    me: () => pendingMe,
  });
  const rendered = renderShellRoute(clientFactory);

  expect(fake.events.subscriberCount("notes")).toBe(0);
  await act(async () => resolveMe({ ok: true, value: { principal: "admin" } }));
  await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
  rendered.unmount();
  expect(fake.events.subscriberCount("notes")).toBe(0);
});

it("keeps foreign and insufficient principals unsubscribed", async () => {
  const fake = createFakeStash({ adminToken: "shell-denied-admin" });
  fake.createStash("notes");
  fake.createStash("other");
  const foreignToken = await fake.mintToken("other", "read");
  const foreign = renderShellRoute((options) =>
    createFakeBackedViewerClient(fake, foreignToken, options.clientId),
  );
  await screen.findByText("read");
  expect(fake.events.subscriberCount("notes")).toBe(0);
  foreign.unmount();

  const readToken = await fake.mintToken("notes", "read");
  const insufficient = renderShellRoute(
    (options) => createFakeBackedViewerClient(fake, readToken, options.clientId),
    { handle: { liveAccess: "write" } },
  );
  await screen.findByText("read");
  expect(fake.events.subscriberCount("notes")).toBe(0);
  insufficient.unmount();
});

it("closes the old credential stream on replacement and every stream on logout", async () => {
  const fake = createFakeStash({ adminToken: "shell-credential-admin" });
  fake.createStash("notes");
  const streams = new Map<string, StashEventStream[]>();
  const clientFactory: ViewerStashClientFactory = (options) => {
    const base = createFakeBackedViewerClient(fake, "shell-credential-admin", options.clientId);
    return {
      ...base,
      files(stash) {
        const files = base.files(stash);
        return {
          ...files,
          events(eventOptions) {
            const stream = files.events(eventOptions);
            const owned = streams.get(options.token) ?? [];
            owned.push(stream);
            streams.set(options.token, owned);
            return stream;
          },
        };
      },
    };
  };
  const rendered = renderShellRoute(clientFactory, { page: <CredentialControls /> });
  await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(1));
  const original = streams.get("zhs_initial")?.[0];
  expect(original).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Active credential").textContent).toBe("zhs_replacement"),
  );
  await waitFor(() => expect(streams.get("zhs_replacement")?.length).toBe(1));
  expect(original?.status).toBe("closed");
  expect(fake.events.subscriberCount("notes")).toBe(1);

  await userEvent.click(screen.getByRole("button", { name: "Control log out" }));
  await waitFor(() => expect(fake.events.subscriberCount("notes")).toBe(0));
  rendered.unmount();
});

it("cycles system, light, and dark themes and persists each explicit mode", async () => {
  stubAdminApi();
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
  render(<RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: ["/"] })} />);

  expect(screen.getByText("History Stash")).toBeTruthy();
  const themeButton = screen.getByRole("button", { name: "Theme: dark" });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("zhs.theme")).toBe("dark");

  await userEvent.click(themeButton);
  expect(screen.getByRole("button", { name: "Theme: system" })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("system");
  expect(localStorage.getItem("zhs.theme")).toBe("system");

  await userEvent.click(screen.getByRole("button", { name: "Theme: system" }));
  expect(screen.getByRole("button", { name: "Theme: light" })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("zhs.theme")).toBe("light");

  await userEvent.click(screen.getByRole("button", { name: "Theme: light" }));
  expect(screen.getByRole("button", { name: "Theme: dark" })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("zhs.theme")).toBe("dark");
});

it("restores a persisted system theme", async () => {
  localStorage.setItem("zhs.theme", "system");
  stubAdminApi();
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");

  render(<RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: ["/"] })} />);

  expect(await screen.findByRole("button", { name: "Theme: system" })).toBeTruthy();
  expect(document.documentElement.dataset.theme).toBe("system");
});
