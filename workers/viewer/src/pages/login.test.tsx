import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClientResult, MeResponse } from "@takazudo/zudo-history-stash";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "../app/auth/token-store.js";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { renderViewerRoute } from "../test/render-viewer-route.js";

describe("LoginPage", () => {
  it("requires a non-empty token", async () => {
    renderViewerRoute("/login", createFakeViewerClient(), { authenticated: false });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter an admin or stash token.",
    );
  });

  it("keeps the deep link through authentication", async () => {
    const client = createFakeViewerClient();
    const { router } = renderViewerRoute("/login?next=%2Fs%2Fx", client, {
      authenticated: false,
    });

    await userEvent.type(screen.getByLabelText("Access token"), "zhs_admin");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/s/x"));
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("zhs_admin");
  });

  it("uses the stash principal home when no safe next path exists", async () => {
    const client = createFakeViewerClient({
      me: async () => ({
        ok: true,
        value: { principal: "stash", stash: "notes", tokenId: "tok_1", scope: "read" },
      }),
    });
    const { router } = renderViewerRoute("/login", client, { authenticated: false });

    await userEvent.type(screen.getByLabelText("Access token"), "zhs_notes");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/s/notes"));
  });

  it("ignores an unsafe next target", async () => {
    const client = createFakeViewerClient();
    const { router } = renderViewerRoute("/login?next=%2F%2Fevil.example", client, {
      authenticated: false,
    });

    await userEvent.type(screen.getByLabelText("Access token"), "zhs_admin");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("shows the pending state while the token is checked", async () => {
    let resolve: ((result: ClientResult<MeResponse>) => void) | undefined;
    const pending = new Promise<ClientResult<MeResponse>>((done) => {
      resolve = done;
    });
    const client = createFakeViewerClient({ me: vi.fn(async () => pending) });
    renderViewerRoute("/login", client, { authenticated: false });

    await userEvent.type(screen.getByLabelText("Access token"), "zhs_admin");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    resolve?.({ ok: true, value: { principal: "admin" } });
  });

  it("keeps the token field and shows an inline 401 error", async () => {
    const client = createFakeViewerClient({
      me: async () => ({
        ok: false,
        error: { status: 401, code: "unauthorized", message: "No" },
      }),
    });
    const { router } = renderViewerRoute("/login", client, { authenticated: false });

    const field = screen.getByLabelText("Access token");
    await userEvent.type(field, "zhs_bad");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "That token was not accepted.",
    );
    expect((field as HTMLInputElement).value).toBe("zhs_bad");
    expect(router.state.location.pathname).toBe("/login");
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
