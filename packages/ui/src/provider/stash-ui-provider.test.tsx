import { createStashClient, type MeResponse, type StashClient } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "./stash-ui-provider.js";
import {
  Anchor,
  useCanWrite,
  useIsAdmin,
  useStashClient,
  useStashClientForSignal,
  useStashHref,
} from "./hooks.js";
import type { StashAnchorProps } from "./types.js";

async function responseFor(me: MeResponse) {
  const adminToken = "test-admin-token";
  const fake = createFakeStash({ adminToken });
  let token = adminToken;
  if (me.principal === "stash") {
    fake.createStash(me.stash);
    token = await fake.mintToken(me.stash, me.scope);
  }
  const fetch = vi.fn(fake.fetch);
  return {
    client: createStashClient({ baseUrl: "https://fake.invalid", token, fetch }),
    fetch,
  };
}

function CapabilityProbe({ stash }: { stash: string }) {
  const write = useCanWrite(stash);
  const admin = useIsAdmin();
  return (
    <output
      data-write-ready={String(write.ready)}
      data-can-write={String(write.canWrite)}
      data-admin-ready={String(admin.ready)}
      data-is-admin={String(admin.isAdmin)}
    />
  );
}

function WriteEffectProbe({ stash, onWrite }: { stash: string; onWrite: () => void }) {
  const client = useStashClient();
  const { canWrite } = useCanWrite(stash);
  useLayoutEffect(() => {
    if (canWrite) onWrite();
  }, [canWrite, client, onWrite]);
  return null;
}

describe("StashUiProvider capabilities", () => {
  it.each([
    ["admin", { principal: "admin" } satisfies MeResponse, "notes", true, true],
    [
      "matching write token",
      {
        principal: "stash",
        stash: "notes",
        tokenId: "tok_1",
        scope: "write",
        expiresAt: null,
      } satisfies MeResponse,
      "notes",
      true,
      false,
    ],
    [
      "matching read token",
      {
        principal: "stash",
        stash: "notes",
        tokenId: "tok_1",
        scope: "read",
        expiresAt: null,
      } satisfies MeResponse,
      "notes",
      false,
      false,
    ],
    [
      "foreign write token",
      {
        principal: "stash",
        stash: "other",
        tokenId: "tok_1",
        scope: "write",
        expiresAt: null,
      } satisfies MeResponse,
      "notes",
      false,
      false,
    ],
  ])("resolves the %s matrix entry", async (_label, principal, stash, canWrite, isAdmin) => {
    const { client, fetch } = await responseFor(principal);
    render(
      <StashUiProvider client={client}>
        <CapabilityProbe stash={stash} />
      </StashUiProvider>,
    );

    const output = screen.getByRole("status");
    expect(output.dataset.writeReady).toBe("false");
    expect(output.dataset.canWrite).toBe("false");

    await waitFor(() => expect(output.dataset.writeReady).toBe("true"));
    expect(output.dataset.canWrite).toBe(String(canWrite));
    expect(output.dataset.adminReady).toBe("true");
    expect(output.dataset.isAdmin).toBe(String(isAdmin));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stays not-ready and denies writes while me is pending", () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    const client = createStashClient({ baseUrl: "https://stash.example", fetch });
    render(
      <StashUiProvider client={client}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );

    const output = screen.getByRole("status");
    expect(output.dataset.writeReady).toBe("false");
    expect(output.dataset.canWrite).toBe("false");
    expect(output.dataset.adminReady).toBe("false");
    expect(output.dataset.isAdmin).toBe("false");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("calls me once per provider mount across child rerenders", async () => {
    const { client, fetch } = await responseFor({ principal: "admin" });
    const rendered = render(
      <StashUiProvider client={client}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );
    await waitFor(() => expect(screen.getByRole("status").dataset.writeReady).toBe("true"));

    rendered.rerender(
      <StashUiProvider client={client}>
        <CapabilityProbe stash="other" />
      </StashUiProvider>,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates the me request across StrictMode effect replay", async () => {
    const { client, fetch } = await responseFor({ principal: "admin" });
    render(
      <StrictMode>
        <StashUiProvider client={client}>
          <CapabilityProbe stash="notes" />
        </StashUiProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByRole("status").dataset.writeReady).toBe("true"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("starts a new me request after a genuine provider remount", async () => {
    const { client, fetch } = await responseFor({ principal: "admin" });
    const firstMount = render(
      <StashUiProvider client={client}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );
    await waitFor(() => expect(screen.getByRole("status").dataset.writeReady).toBe("true"));
    firstMount.unmount();

    render(
      <StashUiProvider client={client}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );
    await waitFor(() => expect(screen.getByRole("status").dataset.writeReady).toBe("true"));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("denies capabilities synchronously when the provider client changes", async () => {
    const { client: adminClient } = await responseFor({ principal: "admin" });
    const pendingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const pendingClient = createStashClient({
      baseUrl: "https://fake.invalid",
      fetch: pendingFetch,
    });
    const onWrite = vi.fn();
    const rendered = render(
      <StashUiProvider client={adminClient}>
        <WriteEffectProbe stash="notes" onWrite={onWrite} />
      </StashUiProvider>,
    );
    await waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
    onWrite.mockClear();

    rendered.rerender(
      <StashUiProvider client={pendingClient}>
        <WriteEffectProbe stash="notes" onWrite={onWrite} />
      </StashUiProvider>,
    );

    expect(onWrite).not.toHaveBeenCalled();
    expect(pendingFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale me result after the provider client changes", async () => {
    const firstClient = createStashClient({ baseUrl: "https://fake.invalid" });
    let resolveFirstRequest!: (result: Awaited<ReturnType<StashClient["me"]>>) => void;
    const firstRequest = new Promise<Awaited<ReturnType<StashClient["me"]>>>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const firstMe = vi.spyOn(firstClient, "me").mockReturnValue(firstRequest);
    const { client: readClient, fetch: readFetch } = await responseFor({
      principal: "stash",
      stash: "notes",
      tokenId: "tok_1",
      scope: "read",
      expiresAt: null,
    });
    const rendered = render(
      <StashUiProvider client={firstClient}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );
    expect(firstMe).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <StashUiProvider client={readClient}>
        <CapabilityProbe stash="notes" />
      </StashUiProvider>,
    );
    const output = screen.getByRole("status");
    await waitFor(() => expect(output.dataset.writeReady).toBe("true"));
    expect(output.dataset.canWrite).toBe("false");
    expect(output.dataset.isAdmin).toBe("false");
    expect(readFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRequest({ ok: true, value: { principal: "admin" } });
      await firstRequest;
    });

    expect(output.dataset.canWrite).toBe("false");
    expect(output.dataset.isAdmin).toBe("false");
  });
});

function FakeAnchor({ children, href, ...props }: StashAnchorProps) {
  return (
    <a {...props} href={`host:${href}`} data-fake-anchor="true">
      {children}
    </a>
  );
}

function BridgeProbe({
  expectedClient,
  signalClient,
  onSignalClient,
}: {
  expectedClient: StashClient;
  signalClient: StashClient;
  onSignalClient: (client: StashClient) => void;
}) {
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const hrefFor = useStashHref();
  return (
    <>
      <output data-client-match={String(client === expectedClient)} />
      <Anchor href={hrefFor({ kind: "stash", stash: "notes" })} aria-label="Open notes">
        notes
      </Anchor>
      <button onClick={() => onSignalClient(clientForSignal(new AbortController().signal))}>
        Resolve signal client
      </button>
      <output data-signal-target={String(signalClient === expectedClient)} />
    </>
  );
}

describe("StashUiProvider bridges", () => {
  it("provides the client, signal client, custom href builder, and accessible Anchor", async () => {
    const { client } = await responseFor({ principal: "admin" });
    const { client: signalClient } = await responseFor({ principal: "admin" });
    const clientForSignal = vi.fn((_signal: AbortSignal) => signalClient);
    const onSignalClient = vi.fn();

    render(
      <StashUiProvider
        client={client}
        clientForSignal={clientForSignal}
        hrefFor={(route) => `/embedded/${route.kind}`}
        Anchor={FakeAnchor}
      >
        <BridgeProbe
          expectedClient={client}
          signalClient={signalClient}
          onSignalClient={onSignalClient}
        />
      </StashUiProvider>,
    );

    expect(screen.getAllByRole("status")[0]?.dataset.clientMatch).toBe("true");
    const link = screen.getByRole("link", { name: "Open notes" });
    expect(link.getAttribute("href")).toBe("host:/embedded/stash");
    expect(link.dataset.fakeAnchor).toBe("true");

    screen.getByRole("button", { name: "Resolve signal client" }).click();
    expect(clientForSignal).toHaveBeenCalledTimes(1);
    expect(clientForSignal.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    expect(onSignalClient).toHaveBeenCalledWith(signalClient);
  });
});
