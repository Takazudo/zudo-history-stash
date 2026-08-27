import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("exercises rotation through the viewer page and renders successor lineage", async () => {
    const fake = createFakeStash({
      adminToken: ADMIN_TOKEN,
      now: () => Date.parse("2026-08-27T09:00:00.000Z"),
    });
    fake.createStash("notes");
    await fake.mintToken("notes", "write", { label: "viewer deploy" });
    const predecessor = [...fake.state.tokens.values()][0];
    if (predecessor === undefined) throw new Error("Missing predecessor fixture");
    const client = createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: fake.fetch });
    const user = userEvent.setup();

    render(
      <StashUiProvider client={client}>
        <MemoryRouter initialEntries={["/s/notes/tokens"]}>
          <Routes>
            <Route path="/s/:stash/tokens" element={<TokensPage />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: `Rotate viewer deploy (${predecessor.id})`,
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Rotate token" });
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Successor expiry" }),
      "day",
    );
    await user.click(within(dialog).getByRole("button", { name: "Confirm rotation" }));

    expect(await screen.findByRole("textbox", { name: "New token secret" })).toBeTruthy();
    expect(
      screen.getByText(
        "If you lose this secret, revoke the successor and mint a new token — a rotated token cannot be rotated again",
      ),
    ).toBeTruthy();
    const successorId = fake.state.tokens.get(predecessor.id)?.rotatedTo;
    if (successorId === null || successorId === undefined) throw new Error("Missing successor");
    expect(fake.state.tokens.get(successorId)?.expiresAt).toBe(
      Date.parse("2026-08-28T09:00:00.000Z"),
    );
    await waitFor(() => {
      const table = screen.getByRole("table", { name: "Tokens for notes" });
      const predecessorRow = table.querySelector(`[data-token-id="${predecessor.id}"]`);
      const successorRow = table.querySelector(`[data-token-id="${successorId}"]`);
      expect(predecessorRow?.textContent).toContain(successorId);
      expect(successorRow?.textContent).toContain(predecessor.id);
      expect(
        within(predecessorRow as HTMLElement).queryByRole("button", {
          name: `Rotate viewer deploy (${predecessor.id})`,
        }),
      ).toBeNull();
    });
  });

  it("preserves non-admin and missing-stash route gating", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash("notes");
    const stashToken = await fake.mintToken("notes", "read");
    const stashClient = createStashClient({
      baseUrl: BASE_URL,
      token: stashToken,
      fetch: fake.fetch,
    });
    const rendered = render(
      <StashUiProvider client={stashClient}>
        <MemoryRouter initialEntries={["/s/notes/tokens"]}>
          <Routes>
            <Route path="/s/:stash/tokens" element={<TokensPage />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );

    expect(await screen.findByText("Token administration is not available")).toBeTruthy();

    const adminClient = createStashClient({
      baseUrl: BASE_URL,
      token: ADMIN_TOKEN,
      fetch: fake.fetch,
    });
    rendered.unmount();
    render(
      <StashUiProvider client={adminClient}>
        <MemoryRouter initialEntries={["/tokens"]}>
          <Routes>
            <Route path="/tokens" element={<TokensPage />} />
          </Routes>
        </MemoryRouter>
      </StashUiProvider>,
    );
    expect(screen.getByText("The stash name is missing from this URL.")).toBeTruthy();
  });
});
