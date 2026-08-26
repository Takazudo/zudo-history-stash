import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY } from "./token-store.js";
import {
  StashClientProvider,
  createViewerStashClient,
  useStashClient,
} from "./stash-client-provider.js";

function LogoutHarness() {
  const { logOut } = useStashClient();
  return <button onClick={logOut}>Log out</button>;
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
  });
});
