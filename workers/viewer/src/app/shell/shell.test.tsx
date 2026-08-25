import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../auth/token-store.js";
import { viewerRoutes } from "../router.js";

it("renders the shell and persists a theme change", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ principal: "admin" })),
  );
  sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
  render(<RouterProvider router={createMemoryRouter(viewerRoutes, { initialEntries: ["/"] })} />);

  expect(screen.getByText("History Stash")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("zhs.theme")).toBe("dark");
});
