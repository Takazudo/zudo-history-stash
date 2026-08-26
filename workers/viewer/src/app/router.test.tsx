import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "./auth/token-store.js";
import { VIEWER_ROUTE_PATHS, viewerRoutes } from "./router.js";

const protectedRoutes = [
  ["/", "Stashes"],
  ["/s/notes", "notes"],
  ["/s/notes/f/folder/readme.txt", "folder/readme.txt"],
  ["/s/notes/diff/folder/readme.txt?from=1&to=head", "Diff: folder/readme.txt"],
  ["/s/notes/edit/folder/readme.txt", "folder/readme.txt"],
  ["/s/notes/new", "New file"],
  ["/s/notes/tokens", "Tokens"],
] as const;

const deniedWriteRoutes = [
  [
    "read token on edit",
    "/s/notes/edit/folder/readme.txt",
    "Editing is not available",
    { principal: "stash", stash: "notes", tokenId: "tok_read", scope: "read" },
  ],
  [
    "read token on new",
    "/s/notes/new",
    "File creation is not available",
    { principal: "stash", stash: "notes", tokenId: "tok_read", scope: "read" },
  ],
  [
    "read token on tokens",
    "/s/notes/tokens",
    "Token administration is not available",
    { principal: "stash", stash: "notes", tokenId: "tok_read", scope: "read" },
  ],
  [
    "foreign write token on edit",
    "/s/notes/edit/folder/readme.txt",
    "Editing is not available",
    { principal: "stash", stash: "other", tokenId: "tok_write", scope: "write" },
  ],
  [
    "foreign write token on new",
    "/s/notes/new",
    "File creation is not available",
    { principal: "stash", stash: "other", tokenId: "tok_write", scope: "write" },
  ],
  [
    "matching write token on tokens",
    "/s/notes/tokens",
    "Token administration is not available",
    { principal: "stash", stash: "notes", tokenId: "tok_write", scope: "write" },
  ],
] as const;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      );
      return Response.json(
        url.pathname.endsWith("/tokens") ? { tokens: [] } : { principal: "admin" },
      );
    }),
  );
});

describe("viewer routes", () => {
  it("pins the complete public route table", () => {
    expect(VIEWER_ROUTE_PATHS).toEqual([
      "/login",
      "/",
      "/s/:stash",
      "/s/:stash/f/*",
      "/s/:stash/diff/*",
      "/s/:stash/edit/*",
      "/s/:stash/new",
      "/s/:stash/tokens",
    ]);
  });

  it("renders the login route without a token", () => {
    render(
      <RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: ["/login"] })} />,
    );
    expect(screen.getByRole("heading", { name: "Open History Stash" })).toBeTruthy();
  });

  it.each(protectedRoutes)("resolves %s through the shared shell", async (path, heading) => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
    render(
      <RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: [path] })} />,
    );
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("admin")).toBeTruthy());
  });

  it("preserves a deep link when redirecting to login", async () => {
    const router = createMemoryRouter(viewerRoutes, { initialEntries: ["/s/x?tab=changes"] });
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Fs%2Fx%3Ftab%3Dchanges");
  });

  it.each(deniedWriteRoutes)(
    "gates a %s after principal lookup only",
    async (_label, path, deniedCopy, principal) => {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_read");
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            "http://localhost",
          );
          requests.push(url.pathname);
          return Response.json(principal);
        }),
      );

      render(
        <RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: [path] })} />,
      );

      expect(await screen.findByText(deniedCopy)).toBeTruthy();
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(requests.every((pathname) => pathname.endsWith("/v1/me"))).toBe(true);
    },
  );

  it("allows a matching write principal to mount the edit workbench", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_write");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          "http://localhost",
        );
        if (url.pathname.endsWith("/v1/me")) {
          return Response.json({
            principal: "stash",
            stash: "notes",
            tokenId: "tok_write",
            scope: "write",
          });
        }
        return new Promise<Response>(() => {
          // Keep the allowed workbench in its loading state.
        });
      }),
    );

    render(
      <RouterProvider
        router={createMemoryRouter(viewerRoutes, {
          initialEntries: ["/s/notes/edit/folder/readme.txt"],
        })}
      />,
    );

    expect(await screen.findByText("Loading edit workbench…")).toBeTruthy();
    expect(screen.queryByText("Editing is not available")).toBeNull();
  });

  it("allows a matching write principal to mount the new-file form", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_write");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          principal: "stash",
          stash: "notes",
          tokenId: "tok_write",
          scope: "write",
        }),
      ),
    );

    render(
      <RouterProvider
        router={createMemoryRouter(viewerRoutes, { initialEntries: ["/s/notes/new"] })}
      />,
    );

    expect(await screen.findByRole("textbox", { name: "Path" })).toBeTruthy();
    expect(screen.queryByText("File creation is not available")).toBeNull();
  });
});
