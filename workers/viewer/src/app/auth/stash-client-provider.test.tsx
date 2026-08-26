import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../../test/fake-viewer-client.js";
import { TOKEN_STORAGE_KEY } from "./token-store.js";
import {
  StashClientProvider,
  createViewerStashClient,
  useStashClient,
} from "./stash-client-provider.js";

function LogoutHarness() {
  const { logOut } = useStashClient();
  return (
    <>
      <button onClick={logOut}>Log out</button>
      <ProviderState />
    </>
  );
}

function ProviderState() {
  const { client, credentialBoundaryWarning, token } = useStashClient();
  return (
    <>
      <output aria-label="Provider token">{token ?? "none"}</output>
      <output aria-label="Provider client">{client === null ? "none" : "active"}</output>
      {credentialBoundaryWarning ? <p role="alert">{credentialBoundaryWarning}</p> : null}
    </>
  );
}

function AuthenticateHarness() {
  const { authenticate } = useStashClient();
  const [outcome, setOutcome] = useState("idle");
  return (
    <>
      <button
        onClick={async () => {
          const result = await authenticate("zhs_replacement");
          setOutcome(result.ok ? "authenticated" : result.error.message);
        }}
      >
        Replace credential
      </button>
      <output>{outcome}</output>
      <ProviderState />
    </>
  );
}

describe("createViewerStashClient", () => {
  it("uses the real SDK against /api with the token and request signal", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ principal: "admin" }),
    );
    const client = createViewerStashClient("zhs_admin", vi.fn(), fetcher);
    const controller = new AbortController();

    const result = await client.me({ signal: controller.signal });

    expect(result).toEqual({ ok: true, value: { principal: "admin" } });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBe("/api/v1/me");
    expect(init?.headers).toEqual({ Authorization: "Bearer zhs_admin" });
    expect(init?.signal).toBe(controller.signal);
  });

  it("notifies the provider when the API returns 401", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () =>
      Response.json({ error: { code: "unauthorized", message: "Expired" } }, { status: 401 }),
    );
    const client = createViewerStashClient("zhs_expired", onUnauthorized, fetcher);

    const result = await client.me();

    expect(result.ok).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("keeps /me failures in the result channel expected by the app shell", async () => {
    const client = createViewerStashClient("zhs_admin", vi.fn(), async () =>
      Response.json({ error: { code: "internal", message: "D1 unavailable" } }, { status: 503 }),
    );

    await expect(client.me()).resolves.toEqual({
      ok: false,
      error: { status: 503, code: "internal", message: "D1 unavailable" },
    });
  });

  it("clears every workbench draft with the Viewer credential on logout", async () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    sessionStorage.setItem("zhs.draft.notes.docs/readme.txt", "draft one");
    sessionStorage.setItem("zhs.draft.other.file.txt", "draft two");
    sessionStorage.setItem("viewer.preference", "keep");
    render(
      <StashClientProvider>
        <LogoutHarness />
      </StashClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("zhs.draft.notes.docs/readme.txt")).toBeNull();
    expect(sessionStorage.getItem("zhs.draft.other.file.txt")).toBeNull();
    expect(sessionStorage.getItem("viewer.preference")).toBe("keep");
    expect(screen.getByLabelText("Provider token").textContent).toBe("none");
    expect(screen.getByLabelText("Provider client").textContent).toBe("none");
  });

  it("deactivates the provider without leaking an event error when logout storage cleanup fails", async () => {
    const onWindowError = vi.fn((event: ErrorEvent) => event.preventDefault());
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    sessionStorage.setItem("zhs.draft.notes.docs/readme.txt", "principal A draft");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    window.addEventListener("error", onWindowError);
    try {
      render(
        <StashClientProvider>
          <LogoutHarness />
        </StashClientProvider>,
      );
      expect(screen.getByLabelText("Provider token").textContent).toBe("zhs_admin");
      expect(screen.getByLabelText("Provider client").textContent).toBe("active");

      await expect(
        userEvent.click(screen.getByRole("button", { name: "Log out" })),
      ).resolves.toBeUndefined();
      await waitFor(() => expect(screen.getByLabelText("Provider token").textContent).toBe("none"));

      expect(screen.getByLabelText("Provider client").textContent).toBe("none");
      expect(screen.getByRole("alert").textContent).toContain("saved token");
      expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("zhs_admin");
      expect(onWindowError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", onWindowError);
    }
  });

  it("uses the public package cleanup before installing a replacement credential", async () => {
    const clientFactory = vi.fn(() => createFakeViewerClient());
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    sessionStorage.setItem("zhs.draft.notes.docs/readme.txt", "principal A draft");
    sessionStorage.setItem("viewer.preference", "keep");
    render(
      <StashClientProvider clientFactory={clientFactory}>
        <AuthenticateHarness />
      </StashClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    await waitFor(() => expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("zhs_replacement"));

    expect(sessionStorage.getItem("zhs.draft.notes.docs/readme.txt")).toBeNull();
    expect(sessionStorage.getItem("viewer.preference")).toBe("keep");
    expect(screen.getByText("authenticated")).toBeTruthy();
  });

  it("keeps the current credential when draft cleanup cannot be confirmed", async () => {
    const clientFactory = vi.fn(() => createFakeViewerClient());
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    sessionStorage.setItem("zhs.draft.notes.docs/readme.txt", "principal A draft");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(
      <StashClientProvider clientFactory={clientFactory}>
        <AuthenticateHarness />
      </StashClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));

    expect(
      await screen.findByText("Workbench drafts could not be cleared. Try signing in again."),
    ).toBeTruthy();
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("zhs_admin");
    expect(sessionStorage.getItem("zhs.draft.notes.docs/readme.txt")).toBe("principal A draft");
  });

  it("does not activate a validated credential when token persistence fails", async () => {
    const clientFactory = vi.fn(() => createFakeViewerClient());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(
      <StashClientProvider clientFactory={clientFactory}>
        <AuthenticateHarness />
      </StashClientProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));

    expect(
      await screen.findByText(
        "The credential could not be stored in this tab. Allow session storage and try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Provider token").textContent).toBe("none");
    expect(screen.getByLabelText("Provider client").textContent).toBe("none");
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});
