import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../auth/token-store.js";
import { viewerRoutes } from "../router.js";

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
