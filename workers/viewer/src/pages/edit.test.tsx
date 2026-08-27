import { createStashClient, type StashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "@takazudo/zudo-history-stash-ui";
import { hasProposalCreatedFlash, PROPOSAL_CREATED_FLASH } from "../app/proposal-routes.js";
import EditPage from "./edit.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "viewer-admin";
const STASH = "notes";
const PATH = "docs/readme.txt";

interface Fixture {
  fake: FakeStash;
  client: StashClient;
  clientForSignal: (signal: AbortSignal) => StashClient;
  requests: Request[];
}

function withSignal(fetch: StashFetch, signal: AbortSignal): StashFetch {
  return (input, init) => fetch(input, init?.signal ? init : { ...init, signal });
}

async function createFixture(token = ADMIN_TOKEN): Promise<Fixture> {
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
  fake.createStash(STASH);
  const seedClient = createStashClient({
    baseUrl: BASE_URL,
    token: ADMIN_TOKEN,
    fetch: fake.fetch,
  });
  const first = await seedClient.files(STASH).put(PATH, {
    body: "first body\n",
    expectedVersion: null,
    author: "Fixture",
    message: "First",
  });
  if (!first.ok) throw new Error(first.error.message);
  const second = await seedClient.files(STASH).put(PATH, {
    body: "head body\n",
    expectedVersion: first.value.version,
    author: "Fixture",
    message: "Head",
  });
  if (!second.ok) throw new Error(second.error.message);

  const requests: Request[] = [];
  const fetch = vi.fn<StashFetch>(async (input, init) => {
    requests.push(new Request(input, init));
    return fake.fetch(input, init);
  });
  return {
    fake,
    client: createStashClient({ baseUrl: BASE_URL, token, fetch }),
    clientForSignal: (signal) =>
      createStashClient({ baseUrl: BASE_URL, token, fetch: withSignal(fetch, signal) }),
    requests,
  };
}

function FileDestination() {
  const location = useLocation();
  const state = location.state as { flash?: string } | null;
  return (
    <div>
      <p>File destination</p>
      <output aria-label="destination path">{location.pathname}</output>
      <output aria-label="destination flash">{state?.flash ?? ""}</output>
    </div>
  );
}

function ProposalDestination() {
  const location = useLocation();
  return (
    <div>
      <p>Proposal destination</p>
      <output aria-label="proposal destination path">{location.pathname}</output>
      <output aria-label="proposal destination flash">
        {hasProposalCreatedFlash(location.state) ? PROPOSAL_CREATED_FLASH : ""}
      </output>
    </div>
  );
}

function renderEditRoute(initialEntry: string, fixture: Fixture) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <StashUiProvider client={fixture.client} clientForSignal={fixture.clientForSignal}>
            <Outlet />
          </StashUiProvider>
        ),
        children: [
          { path: "/s/:stash/edit/*", element: <EditPage /> },
          { path: "/s/:stash/f/*", element: <FileDestination /> },
          { path: "/s/:stash/proposals/:id", element: <ProposalDestination /> },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

function mockWideViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockWideViewport();
});

describe("EditPage", () => {
  it("reads stash, wildcard path, and from=N into the package workbench", async () => {
    const fixture = await createFixture();
    renderEditRoute("/s/notes/edit/docs/readme.txt?from=1", fixture);

    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    expect(editor.value).toBe("first body\n");
    expect(screen.getByRole("heading", { level: 1, name: PATH })).toBeTruthy();
    expect(screen.getByText("Edit · notes")).toBeTruthy();
    expect(screen.getByText("Editing from v1")).toBeTruthy();
  });

  it("renders denied direct navigation after only the principal request", async () => {
    const admin = await createFixture();
    const readToken = await admin.fake.mintToken(STASH, "read");
    const requests: Request[] = [];
    const fetch = vi.fn<StashFetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return admin.fake.fetch(input, init);
    });
    const fixture: Fixture = {
      fake: admin.fake,
      client: createStashClient({ baseUrl: BASE_URL, token: readToken, fetch }),
      clientForSignal: (signal) =>
        createStashClient({
          baseUrl: BASE_URL,
          token: readToken,
          fetch: withSignal(fetch, signal),
        }),
      requests,
    };
    renderEditRoute("/s/notes/edit/docs/readme.txt", fixture);

    expect(await screen.findByText("Editing is not available")).toBeTruthy();
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    expect(request?.method).toBe("GET");
    expect(new URL(request?.url ?? BASE_URL).pathname).toBe("/v1/me");
    expect(fixture.requests.some((entry) => entry.url.includes("/files/"))).toBe(false);
  });

  it("does not start workbench reads while the capability request is pending", async () => {
    const fixture = await createFixture();
    let releaseMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    const requests: Request[] = [];
    const gatedFetch = vi.fn<StashFetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (new URL(request.url).pathname === "/v1/me") await meGate;
      return fixture.fake.fetch(input, init);
    });
    const gated: Fixture = {
      ...fixture,
      client: createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: gatedFetch }),
      clientForSignal: (signal) =>
        createStashClient({
          baseUrl: BASE_URL,
          token: ADMIN_TOKEN,
          fetch: withSignal(gatedFetch, signal),
        }),
      requests,
    };
    renderEditRoute("/s/notes/edit/docs/readme.txt", gated);

    expect(screen.getByText("Checking write access…")).toBeTruthy();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? BASE_URL).pathname).toBe("/v1/me");
    releaseMe();
    expect(await screen.findByRole("textbox", { name: "Draft body" })).toBeTruthy();
  });

  it("rejects an invalid from query without mounting the data workbench", async () => {
    const fixture = await createFixture();
    renderEditRoute("/s/notes/edit/docs/readme.txt?from=zero", fixture);

    expect(await screen.findByText("The from query must be a positive integer.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Draft body" })).toBeNull();
    expect(fixture.requests).toHaveLength(1);
    expect(new URL(fixture.requests[0]?.url ?? BASE_URL).pathname).toBe("/v1/me");
  });

  it("navigates to the canonical file URL with a save flash after the internal refresh", async () => {
    const fixture = await createFixture();
    const { router } = renderEditRoute("/s/notes/edit/docs/readme.txt", fixture);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "saved from viewer\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save v3" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await userEvent.click(save);

    await waitFor(() => expect(router.state.location.pathname).toBe("/s/notes/f/docs/readme.txt"));
    expect(await screen.findByText("File destination")).toBeTruthy();
    expect(screen.getByLabelText("destination path").textContent).toBe(
      "/s/notes/f/docs/readme.txt",
    );
    expect(screen.getByLabelText("destination flash").textContent).toBe("Saved v3.");
  });

  it("navigates to the proposal href with a typed flash without moving the file head", async () => {
    const fixture = await createFixture();
    const { router } = renderEditRoute("/s/notes/edit/docs/readme.txt", fixture);
    const editor = (await screen.findByRole("textbox", {
      name: "Draft body",
    })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "proposed from viewer\n" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save…" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Author" }), "Ada");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Message" }), "Please review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as proposal" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/s\/notes\/proposals\/prp_/u),
    );
    expect(await screen.findByText("Proposal destination")).toBeTruthy();
    expect(screen.getByLabelText("proposal destination path").textContent).toBe(
      router.state.location.pathname,
    );
    expect(screen.getByLabelText("proposal destination flash").textContent).toBe(
      PROPOSAL_CREATED_FLASH,
    );
    const head = await fixture.client.files(STASH).get(PATH);
    expect(head.ok && !("notModified" in head) && head.value.version).toBe(2);
    expect(head.ok && !("notModified" in head) && head.value.body).toBe("head body\n");
  });
});
