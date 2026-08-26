import { createStashClient, type StashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { NewFileForm, type NewFileCreated } from "./new-file-form.js";

const BASE_URL = "https://stash.test";
const ADMIN_TOKEN = "fixture-admin-token";
const STASH = "notes";

interface LoggedRequest {
  method: string;
  pathname: string;
  body: unknown;
  idempotencyKey: string | null;
}

interface Fixture {
  fake: FakeStash;
  client: StashClient;
  requests: LoggedRequest[];
}

async function logRequest(request: Request, requests: LoggedRequest[]): Promise<void> {
  requests.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.clone().json(),
    idempotencyKey: request.headers.get("Idempotency-Key"),
  });
}

async function makeFixture(scope: "read" | "write" = "write"): Promise<Fixture> {
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
  fake.createStash(STASH);
  const token = await fake.mintToken(STASH, scope);
  const requests: LoggedRequest[] = [];
  const fetch: StashFetch = async (input, init) => {
    const request = new Request(input, init);
    await logRequest(request, requests);
    return fake.fetch(request);
  };
  return {
    fake,
    requests,
    client: createStashClient({ baseUrl: BASE_URL, token, fetch }),
  };
}

function seedClient(fake: FakeStash): StashClient {
  return createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: fake.fetch });
}

function renderForm(fixture: Fixture, onCreated: (created: NewFileCreated) => void = vi.fn()) {
  return {
    onCreated,
    ...render(
      <StashUiProvider client={fixture.client}>
        <NewFileForm stash={STASH} onCreated={onCreated} />
      </StashUiProvider>,
    ),
  };
}

function puts(requests: LoggedRequest[]): LoggedRequest[] {
  return requests.filter((request) => request.method === "PUT");
}

describe("NewFileForm", () => {
  it("creates an empty file through the real client/fake boundary with optional metadata", async () => {
    const fixture = await makeFixture();
    const onCreated = vi.fn();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    renderForm(fixture, onCreated);
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox", { name: "Path" }), "docs/empty.txt");
    await user.type(screen.getByRole("textbox", { name: /Author/ }), "  Ada  ");
    await user.type(screen.getByRole("textbox", { name: /Message/ }), "  Initial version  ");
    await user.click(screen.getByRole("button", { name: "Create file" }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ path: "docs/empty.txt", version: 1 }),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(puts(fixture.requests)).toEqual([
      {
        method: "PUT",
        pathname: "/v1/stashes/notes/files/docs/empty.txt",
        body: {
          body: "",
          expectedVersion: null,
          author: "Ada",
          message: "Initial version",
        },
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
      },
    ]);
  });

  it("validates paths live and blocks programmatic submission without a data call", async () => {
    const fixture = await makeFixture();
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);
    const user = userEvent.setup();

    const path = await screen.findByRole("textbox", { name: "Path" });
    await user.type(path, "../secret");
    expect(screen.getByRole("alert").textContent).toBe("Invalid file path");
    expect(path.getAttribute("aria-invalid")).toBe("true");
    fireEvent.submit(screen.getByRole("button", { name: "Create file" }).closest("form")!);

    expect(fixture.requests).toEqual([
      {
        method: "GET",
        pathname: "/v1/me",
        body: undefined,
        idempotencyKey: null,
      },
    ]);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows authoritative live-head state and routes Open through the provider Anchor", async () => {
    const fixture = await makeFixture();
    const seeded = await seedClient(fixture.fake)
      .files(STASH)
      .put(
        "existing.txt",
        { body: "remote", expectedVersion: null, author: "Lin" },
        { idempotencyKey: "seed-live" },
      );
    expect(seeded.ok).toBe(true);
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox", { name: "Path" }), "existing.txt");
    await user.type(screen.getByRole("textbox", { name: "File body" }), "local");
    await user.click(screen.getByRole("button", { name: "Create file" }));

    expect(await screen.findByText("This path exists")).toBeTruthy();
    expect(
      screen.getByText("The path already has a live head at v1, written by Lin."),
    ).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open file" });
    expect(open.textContent).toBe("Open the file");
    expect(open.getAttribute("href")).toBe("/s/notes/f/existing.txt");
    expect(puts(fixture.requests)[0]?.body).toMatchObject({ expectedVersion: null, body: "local" });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("requires an explicit second action to resurrect a tombstone with a new fence and key", async () => {
    const fixture = await makeFixture();
    const seededClient = seedClient(fixture.fake);
    const created = await seededClient
      .files(STASH)
      .put(
        "deleted.txt",
        { body: "old", expectedVersion: null, author: "Lin" },
        { idempotencyKey: "seed-create" },
      );
    expect(created.ok).toBe(true);
    const deleted = await seededClient
      .files(STASH)
      .delete(
        "deleted.txt",
        { expectedVersion: 1, author: "Lin" },
        { idempotencyKey: "seed-delete" },
      );
    expect(deleted.ok).toBe(true);
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox", { name: "Path" }), "deleted.txt");
    await user.type(screen.getByRole("textbox", { name: "File body" }), "resurrected");
    await user.type(screen.getByRole("textbox", { name: /Author/ }), "Ada");
    await user.type(screen.getByRole("textbox", { name: /Message/ }), "Restore content");
    await user.click(screen.getByRole("button", { name: "Create file" }));

    const resurrect = await screen.findByRole("button", { name: "Resurrect with this content" });
    expect(onCreated).not.toHaveBeenCalled();
    expect(puts(fixture.requests)).toHaveLength(1);
    expect(puts(fixture.requests)[0]).toMatchObject({
      body: {
        body: "resurrected",
        expectedVersion: null,
        author: "Ada",
        message: "Restore content",
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    });

    await user.click(resurrect);
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ path: "deleted.txt", version: 3 }),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(puts(fixture.requests)).toHaveLength(2);
    expect(puts(fixture.requests)[1]).toMatchObject({
      body: {
        body: "resurrected",
        expectedVersion: 2,
        author: "Ada",
        message: "Restore content",
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
    });
  });

  it("renders not available for a read principal and records only the capability request", async () => {
    const fixture = await makeFixture("read");
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);

    expect(screen.getByText("Checking write access…")).toBeTruthy();
    expect(await screen.findByText("File creation is not available")).toBeTruthy();
    await act(async () => Promise.resolve());
    expect(fixture.requests).toEqual([
      {
        method: "GET",
        pathname: "/v1/me",
        body: undefined,
        idempotencyKey: null,
      },
    ]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("replays the exact frozen request and key only after a transport failure", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash(STASH);
    const token = await fake.mintToken(STASH, "write");
    const requests: LoggedRequest[] = [];
    let interruptNextPut = true;
    const fetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      await logRequest(request, requests);
      if (request.method === "PUT" && interruptNextPut) {
        interruptNextPut = false;
        throw new TypeError("Connection dropped");
      }
      return fake.fetch(request);
    };
    const fixture: Fixture = {
      fake,
      requests,
      client: createStashClient({ baseUrl: BASE_URL, token, fetch }),
    };
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000001");
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox", { name: "Path" }), "retry.txt");
    await user.type(screen.getByRole("textbox", { name: "File body" }), "frozen body");
    await user.click(screen.getByRole("button", { name: "Create file" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect((screen.getByRole("textbox", { name: "Path" }) as HTMLInputElement).disabled).toBe(true);

    await user.click(retry);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ path: "retry.txt", version: 1 }));
    expect(puts(requests)).toHaveLength(2);
    expect(puts(requests)[1]?.body).toEqual(puts(requests)[0]?.body);
    expect(puts(requests)[1]?.idempotencyKey).toBe(puts(requests)[0]?.idempotencyKey);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("atomically ignores duplicate submissions while a create request is pending", async () => {
    const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
    fake.createStash(STASH);
    const token = await fake.mintToken(STASH, "write");
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let notifyPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve;
    });
    const requests: LoggedRequest[] = [];
    const fetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      await logRequest(request, requests);
      if (request.method === "PUT") {
        notifyPutStarted();
        await putGate;
      }
      return fake.fetch(request);
    };
    const fixture: Fixture = {
      fake,
      requests,
      client: createStashClient({ baseUrl: BASE_URL, token, fetch }),
    };
    const onCreated = vi.fn();
    renderForm(fixture, onCreated);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Path" }), "atomic.txt");
    const form = screen.getByRole("button", { name: "Create file" }).closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    await putStarted;
    expect(puts(requests)).toHaveLength(1);

    await act(async () => releasePut());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith({ path: "atomic.txt", version: 1 });
  });

  it("isolates a pending result when the provider client and stash target change", async () => {
    const oldFake = createFakeStash({ adminToken: ADMIN_TOKEN });
    const newFake = createFakeStash({ adminToken: ADMIN_TOKEN });
    oldFake.createStash("old-stash");
    newFake.createStash("new-stash");
    const oldToken = await oldFake.mintToken("old-stash", "write");
    const newToken = await newFake.mintToken("new-stash", "write");
    let releaseOldPut!: () => void;
    const oldPutGate = new Promise<void>((resolve) => {
      releaseOldPut = resolve;
    });
    let notifyOldPutStarted!: () => void;
    const oldPutStarted = new Promise<void>((resolve) => {
      notifyOldPutStarted = resolve;
    });
    const oldFetch: StashFetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "PUT") {
        notifyOldPutStarted();
        await oldPutGate;
      }
      return oldFake.fetch(request);
    };
    const oldClient = createStashClient({ baseUrl: BASE_URL, token: oldToken, fetch: oldFetch });
    const newClient = createStashClient({
      baseUrl: BASE_URL,
      token: newToken,
      fetch: newFake.fetch,
    });
    const onCreated = vi.fn();
    const rendered = render(
      <StashUiProvider client={oldClient}>
        <NewFileForm stash="old-stash" onCreated={onCreated} />
      </StashUiProvider>,
    );
    const user = userEvent.setup();

    await user.type(await screen.findByRole("textbox", { name: "Path" }), "old.txt");
    await user.click(screen.getByRole("button", { name: "Create file" }));
    await oldPutStarted;

    rendered.rerender(
      <StashUiProvider client={newClient}>
        <NewFileForm stash="new-stash" onCreated={onCreated} />
      </StashUiProvider>,
    );
    await user.type(await screen.findByRole("textbox", { name: "Path" }), "new.txt");
    await user.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ path: "new.txt", version: 1 }));

    await act(async () => releaseOldPut());
    await act(async () => Promise.resolve());
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
