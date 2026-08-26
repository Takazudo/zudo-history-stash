import { render, screen } from "@testing-library/react";
import { createStashClient } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StashUiProvider } from "@takazudo/zudo-history-stash-ui";
import TokensPage from "./tokens.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";

describe("TokensPage", () => {
  it("reads the stash route parameter and renders the package panel", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash("notes");
    const client = createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: fake.fetch });

    render(
      <StashUiProvider client={client}>
        <MemoryRouter initialEntries={["/s/notes/tokens"]}>
          <Routes>
            <Route path="/s/:stash/tokens" element={<TokensPage />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Tokens" })).toBeTruthy();
    expect(screen.getByText("Manage access to notes.")).toBeTruthy();
    expect(await screen.findByText("No tokens have been minted for this stash.")).toBeTruthy();
  });
});
