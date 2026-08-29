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
  ["/s/notes/commits", "Commits"],
  ["/s/notes/commits/cmt_1756108800000abcdef12", "Commit"],
  ["/s/notes/change-sets", "Change sets"],
  ["/s/notes/change-sets/chs_1756108800000abcdef12", "Change set"],
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

let requests: URL[] = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      );
      requests.push(url);
      if (url.pathname.endsWith("/files")) {
        return Response.json({ files: [], nextAfter: null });
      }
      if (url.pathname.endsWith("/changes")) {
        return Response.json({ changes: [], hasMore: false, nextBefore: null });
      }
      if (url.pathname.endsWith("/v1/stashes")) {
        return Response.json({ stashes: [], nextAfter: null });
      }
      if (url.pathname.endsWith("/v1/admin/gc/runs")) {
        return Response.json({ runs: [] });
      }
      if (url.pathname.endsWith("/commits")) {
        return Response.json({ commits: [], nextAfter: null, total: 0 });
      }
      if (url.pathname.includes("/commits/") && url.pathname.endsWith("/diff")) {
        return Response.json({ entries: [], truncated: false });
      }
      if (url.pathname.includes("/commits/")) {
        return Response.json({
          id: "cmt_1756108800000abcdef12",
          stash: "notes",
          source: "manual",
          sourceId: null,
          author: "admin",
          message: "Fixture commit",
          meta: {},
          entryCount: 0,
          firstChangeId: 0,
          lastChangeId: 0,
          revertsCommitId: null,
          createdBy: "admin",
          createdAt: "2026-08-25T08:00:00.000Z",
          entries: [],
        });
      }
      if (url.pathname.endsWith("/change-sets")) {
        return Response.json({ changeSets: [], nextAfter: null, total: 0 });
      }
      if (url.pathname.includes("/change-sets/") && url.pathname.endsWith("/diff")) {
        return Response.json({ entries: [], stale: false, status: "open", truncated: false });
      }
      if (url.pathname.includes("/change-sets/")) {
        return Response.json({
          id: "chs_1756108800000abcdef12",
          stash: "notes",
          status: "open",
          author: "admin",
          message: "Fixture change set",
          meta: {},
          expiresAt: "2026-09-01T00:00:00.000Z",
          createdBy: "admin",
          createdAt: "2026-08-25T08:00:00.000Z",
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          commitId: null,
          entries: [],
        });
      }
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
      "/s/:stash/commits",
      "/s/:stash/commits/:id",
      "/s/:stash/change-sets",
      "/s/:stash/change-sets/:id",
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
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("admin")).toBeTruthy());
    if (path === "/") {
      expect(await screen.findByText("No recent runs for this kind.")).toBeTruthy();
      const historyRequest = requests.find((url) => url.pathname.endsWith("/v1/admin/gc/runs"));
      expect(historyRequest?.searchParams.get("kind")).toBe("r2-orphans");
      expect(historyRequest?.searchParams.get("limit")).toBe("10");
    }
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
