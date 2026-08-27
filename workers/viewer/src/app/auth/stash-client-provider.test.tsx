import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClientResult, MeResponse } from "@takazudo/zudo-history-stash";
import { useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createFakeViewerClient } from "../../test/fake-viewer-client.js";
import { useMe } from "./use-me.js";
import { TOKEN_STORAGE_KEY } from "./token-store.js";
import {
  StashClientProvider,
  VIEWER_CLIENT_ID_STORAGE_KEY,
  createViewerStashClient,
  type ViewerClientIdStore,
  type ViewerStashClientFactory,
  useStashClient,
} from "./stash-client-provider.js";

function clientIdStore(initial?: string): ViewerClientIdStore & { value: string | null } {
  const store = {
    value: initial ?? null,
    getItem: vi.fn(() => store.value),
    setItem: vi.fn((_key: string, value: string) => {
      store.value = value;
    }),
  };
  return store;
}

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
  const { client, clientId, credentialBoundaryWarning, token } = useStashClient();
  return (
    <>
      <output aria-label="Provider token">{token ?? "none"}</output>
      <output aria-label="Provider client">{client === null ? "none" : "active"}</output>
      <output aria-label="Provider client id">{clientId}</output>
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

function CredentialFenceHarness({ observed }: { observed: string[] }) {
  const { authenticate, token } = useStashClient();
  const me = useMe();
  const [outcome, setOutcome] = useState("idle");
  const principal =
    me.status === "ready" ? (me.me.principal === "admin" ? "admin" : me.me.scope) : me.status;
  useLayoutEffect(() => {
    observed.push(`${token ?? "none"}:${principal}`);
  }, [observed, principal, token]);

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
      <output aria-label="App principal">{principal}</output>
    </>
  );
}

describe("createViewerStashClient", () => {
  it("uses the real SDK against /api with the token and request signal", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ principal: "admin" }),
    );
    const client = createViewerStashClient({
      token: "zhs_admin",
      clientId: "tab-auth-test",
      onUnauthorized: vi.fn(),
      fetch: fetcher,
    });
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
    const client = createViewerStashClient({
      token: "zhs_expired",
      clientId: "tab-auth-test",
      onUnauthorized,
      fetch: fetcher,
    });

    const result = await client.me();

    expect(result.ok).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("reuses the exact client id for mutations made by base and signal-bound clients", async () => {
    const requests: Request[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestInput =
        input instanceof Request ? input : new URL(String(input), "https://viewer.test");
      requests.push(new Request(requestInput, init));
      signals.push(init?.signal);
      return Response.json(
        {
          version: requests.length,
          hash: `sha256-${"a".repeat(64)}`,
          size: 4,
          changeId: requests.length,
          createdAt: "2026-08-28T00:00:00.000Z",
        },
        { status: 201 },
      );
    });
    const client = createViewerStashClient({
      token: "zhs_admin",
      clientId: "tab-mutations",
      onUnauthorized: vi.fn(),
      fetch: fetcher,
    });
    const signal = new AbortController().signal;

    await client
      .files("notes")
      .put("a.txt", { body: "one", expectedVersion: null }, { idempotencyKey: "put-a" });
    await client
      .withSignal(signal)
      .files("notes")
      .put("b.txt", { body: "two", expectedVersion: null }, { idempotencyKey: "put-b" });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get("x-stash-client-id"))).toEqual([
      "tab-mutations",
      "tab-mutations",
    ]);
    expect(signals[1]).toBe(signal);
  });

  it("keeps /me failures in the result channel expected by the app shell", async () => {
    const client = createViewerStashClient({
      token: "zhs_admin",
      clientId: "tab-auth-test",
      onUnauthorized: vi.fn(),
      fetch: async () =>
        Response.json({ error: { code: "internal", message: "D1 unavailable" } }, { status: 503 }),
    });

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
    const clientFactory = vi.fn<ViewerStashClientFactory>(() => createFakeViewerClient());
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

  it("keeps one tab-scoped client id across credential replacement and provider remount", async () => {
    const clientFactory = vi.fn<ViewerStashClientFactory>(() => createFakeViewerClient());
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    const first = render(
      <StashClientProvider clientFactory={clientFactory}>
        <AuthenticateHarness />
      </StashClientProvider>,
    );
    const clientId = screen.getByLabelText("Provider client id").textContent;
    expect(clientId).toBeTruthy();
    expect(clientId).toBe(sessionStorage.getItem(VIEWER_CLIENT_ID_STORAGE_KEY));

    await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    await waitFor(() => expect(screen.getByText("authenticated")).toBeTruthy());
    expect(clientFactory.mock.calls.every(([options]) => options.clientId === clientId)).toBe(true);

    first.unmount();
    render(
      <StashClientProvider clientFactory={clientFactory}>
        <ProviderState />
      </StashClientProvider>,
    );
    expect(screen.getByLabelText("Provider client id").textContent).toBe(clientId);
    expect(clientFactory.mock.calls.at(-1)?.[0].clientId).toBe(clientId);
  });

  it("uses distinct identities for independent tab stores and replaces an invalid stored value", () => {
    const clientFactory = vi.fn<ViewerStashClientFactory>(() => createFakeViewerClient());
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    const firstStore = clientIdStore("invalid\nvalue");
    const first = render(
      <StashClientProvider clientFactory={clientFactory} clientIdStore={firstStore}>
        <ProviderState />
      </StashClientProvider>,
    );
    const firstId = screen.getByLabelText("Provider client id").textContent;
    expect(firstId).toBeTruthy();
    expect(firstId).not.toBe("invalid\nvalue");
    expect(firstStore.value).toBe(firstId);
    first.unmount();

    const secondStore = clientIdStore();
    const second = render(
      <StashClientProvider clientFactory={clientFactory} clientIdStore={secondStore}>
        <ProviderState />
      </StashClientProvider>,
    );
    const secondId = screen.getByLabelText("Provider client id").textContent;
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    second.unmount();

    render(
      <StashClientProvider clientFactory={clientFactory} clientIdStore={firstStore}>
        <ProviderState />
      </StashClientProvider>,
    );
    expect(screen.getByLabelText("Provider client id").textContent).toBe(firstId);
  });

  it("keeps a denied tab store identity in memory across remounts without disabling auth", () => {
    const clientFactory = vi.fn<ViewerStashClientFactory>(() => createFakeViewerClient());
    const deniedStore: ViewerClientIdStore = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    const first = render(
      <StashClientProvider clientFactory={clientFactory} clientIdStore={deniedStore}>
        <ProviderState />
      </StashClientProvider>,
    );
    const firstId = screen.getByLabelText("Provider client id").textContent;
    expect(firstId).toBeTruthy();
    expect(screen.getByLabelText("Provider client").textContent).toBe("active");
    first.unmount();

    render(
      <StashClientProvider clientFactory={clientFactory} clientIdStore={deniedStore}>
        <ProviderState />
      </StashClientProvider>,
    );
    expect(screen.getByLabelText("Provider client id").textContent).toBe(firstId);
    expect(screen.getByLabelText("Provider client").textContent).toBe("active");
    expect(clientFactory.mock.calls.every(([options]) => options.clientId === firstId)).toBe(true);
  });

  it("fences the app principal immediately when the credential client changes", async () => {
    let replacementMeCalls = 0;
    const pendingActiveMe = new Promise<ClientResult<MeResponse>>(() => {
      // The active replacement principal remains unresolved for this assertion.
    });
    const clientFactory: ViewerStashClientFactory = (options) =>
      createFakeViewerClient({
        me: async () => {
          if (options.token === "zhs_admin") {
            return { ok: true, value: { principal: "admin" } };
          }
          replacementMeCalls += 1;
          if (replacementMeCalls === 1) {
            return {
              ok: true,
              value: {
                principal: "stash",
                stash: "notes",
                tokenId: "tok_replacement",
                scope: "read",
                expiresAt: null,
              },
            };
          }
          return pendingActiveMe;
        },
      });
    const observed: string[] = [];
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    render(
      <StashClientProvider clientFactory={clientFactory}>
        <CredentialFenceHarness observed={observed} />
      </StashClientProvider>,
    );
    expect(await screen.findByText("admin")).toBeTruthy();
    observed.length = 0;

    await userEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    expect(await screen.findByText("authenticated")).toBeTruthy();

    expect(observed).toContain("zhs_replacement:idle");
    expect(observed).not.toContain("zhs_replacement:admin");
    expect(screen.getByLabelText("App principal").textContent).toBe("loading");
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
