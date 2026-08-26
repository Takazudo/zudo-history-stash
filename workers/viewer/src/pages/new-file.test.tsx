import { createStashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "@takazudo/zudo-history-stash-ui";
import NewFilePage from "./new-file.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";

function Destination() {
  const location = useLocation();
  return <output aria-label="destination">{`${location.pathname}${location.search}`}</output>;
}

describe("NewFilePage", () => {
  it("reads the stash route, delegates creation to the package form, and navigates to the file", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash("notes");
    const token = await fake.mintToken("notes", "write");
    const requests: Request[] = [];
    const fetch = vi.fn<StashFetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return fake.fetch(request);
    });
    const client = createStashClient({ baseUrl: BASE_URL, token, fetch });
    const user = userEvent.setup();

    render(
      <StashUiProvider client={client}>
        <MemoryRouter initialEntries={["/s/notes/new"]}>
          <Routes>
            <Route path="/s/:stash/new" element={<NewFilePage />} />
            <Route path="/s/:stash/f/*" element={<Destination />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "New file" })).toBeTruthy();
    expect(screen.getByText("Create a file in notes.")).toBeTruthy();
    await user.type(await screen.findByRole("textbox", { name: "Path" }), "docs/readme.txt");
    await user.type(screen.getByRole("textbox", { name: "File body" }), "hello");
    await user.click(screen.getByRole("button", { name: "Create file" }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "destination" }).textContent).toBe(
        "/s/notes/f/docs/readme.txt",
      ),
    );
    const put = requests.find((request) => request.method === "PUT");
    expect(put && (await put.json())).toEqual({ body: "hello", expectedVersion: null });
  });

  it("renders a pure missing-stash error without attempting a file operation", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    const requests: Request[] = [];
    const fetch = vi.fn<StashFetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return fake.fetch(request);
    });
    const client = createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch });

    render(
      <StashUiProvider client={client}>
        <MemoryRouter initialEntries={["/new"]}>
          <Routes>
            <Route path="/new" element={<NewFilePage />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "The stash name is missing from this URL.",
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/me");
  });
});
