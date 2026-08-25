import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "./auth/token-store.js";
import { viewerRoutes } from "./router.js";

const protectedRoutes = [
  ["/", "Stashes"],
  ["/s/notes", "notes"],
  ["/s/notes/f/folder/readme.txt", "folder/readme.txt"],
  ["/s/notes/diff/folder/readme.txt?from=1&to=head", "Diff: folder/readme.txt"],
] as const;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ principal: "admin" })),
  );
});

describe("viewer routes", () => {
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
});
