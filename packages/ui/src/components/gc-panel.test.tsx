import { createStashClient, type GcRunResult, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { GcPanel } from "./gc-panel.js";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const ADMIN = "test-admin";
const PRIVATE_KEY = `v2/notes/sha256-${"a".repeat(64)}/00000000-0000-4000-8000-000000000001`;

function requestFor(call: Parameters<StashFetch>): Request {
  return new Request(call[0], call[1]);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function persistedRun(overrides: Partial<GcRunResult> = {}): GcRunResult {
  return {
    runId: "persisted-run",
    jobId: "r2-orphans",
    kind: "r2-orphans",
    dryRun: false,
    scanned: 7,
    eligible: 4,
    deleted: 3,
    cursor: "opaque-persisted-cursor",
    startedAt: "2026-08-26T23:00:00.000Z",
    finishedAt: "2026-08-26T23:00:01.000Z",
    error: "public retry note",
    ...overrides,
  };
}

function adminFixture() {
  const fake = createFakeStash({ adminToken: ADMIN, now: () => NOW });
  fake.createStash("notes");
  const old = NOW - 900_001;
  for (const [index, letter] of ["a", "b"].entries()) {
    const hash = `sha256-${letter.repeat(64)}`;
    const key = index === 0 ? PRIVATE_KEY : `v2/notes/${hash}/00000000-0000-4000-8000-000000000002`;
    fake.state.r2Objects.set(key, { key, stash: "notes", hash, size: 1, createdAt: old });
  }
  const fetch = vi.fn<StashFetch>(fake.fetch);
  const client = createStashClient({ baseUrl: "https://fake.invalid", token: ADMIN, fetch });
  return { fake, fetch, client };
}

function renderPanel(client: ReturnType<typeof createStashClient>) {
  return render(
    <StashUiProvider client={client}>
      <GcPanel />
    </StashUiProvider>,
  );
}

describe("GcPanel", () => {
  it("runs a dry page and renders public counts, IDs, timestamps, and opaque cursor only", async () => {
    const { client } = adminFixture();
    renderPanel(client);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", { name: "Maintenance" });
    await user.clear(within(panel).getByRole("spinbutton", { name: "Max objects" }));
    await user.type(within(panel).getByRole("spinbutton", { name: "Max objects" }), "1");
    await user.click(within(panel).getByRole("button", { name: "Run" }));

    const current = await within(panel).findByRole("region", { name: "Current run" });
    expect(current.textContent).toContain("Dry run");
    expect(current.textContent).toContain("Scanned1");
    expect(current.textContent).toContain("Eligible1");
    expect(current.textContent).toContain("Deleted0");
    expect(current.textContent).toContain("r2-orphans");
    expect(current.textContent).toContain("00000000-0000-4000-8000-000000000001");
    expect(current.textContent).toContain("fake-gc-cursor-");
    expect(current.textContent).toContain(new Date(NOW).toISOString());
    expect(screen.getByRole("region", { name: /Run 00000000/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain(PRIVATE_KEY);
    expect(document.body.textContent).not.toContain("lease generation");
  });

  it("associates accessible 1..500 validation and blocks invalid runs", async () => {
    const { client, fetch } = adminFixture();
    renderPanel(client);
    const user = userEvent.setup();
    const input = await screen.findByRole("spinbutton", { name: "Max objects" });
    await user.clear(input);
    await user.type(input, "501");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("1 through 500");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    expect(
      fetch.mock.calls
        .map(requestFor)
        .filter((request) => request.method === "POST" && request.url.endsWith("/v1/admin/gc")),
    ).toHaveLength(0);
  });

  it("renders actionable 409 busy guidance", async () => {
    const { client, fake } = adminFixture();
    const job = fake.state.gcJobs.get("r2-orphans")!;
    job.leaseOwner = "active";
    job.leaseUntil = NOW + 300_000;
    renderPanel(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Run" }));

    const warning = await screen.findByText("Garbage collection is already running.");
    expect(warning.parentElement?.textContent).toContain("five-minute lease expires");
  });

  it("turns a server-rejected opaque cursor into actionable validation guidance", async () => {
    const { client } = adminFixture();
    renderPanel(client);
    const user = userEvent.setup();
    await user.click(await screen.findByText("Advanced cursor"));
    await user.type(
      screen.getByRole("textbox", { name: "Opaque cursor override" }),
      "malformed-cursor",
    );
    await user.click(screen.getByRole("button", { name: "Run" }));

    const guidance = await screen.findByText("Review the maintenance input.");
    expect(guidance.parentElement?.textContent).toContain(
      "opaque cursor returned for that same kind",
    );
    expect(guidance.parentElement?.textContent).toContain("1–500 max objects");
  });

  it("loads persisted recent runs from the admin history endpoint", async () => {
    const { client, fake, fetch } = adminFixture();
    fake.state.gcRuns.push(persistedRun());
    renderPanel(client);

    const recent = await screen.findByRole("region", { name: "Run persisted-run" });
    expect(recent.textContent).toContain("Scanned7");
    expect(recent.textContent).toContain("Eligible4");
    expect(recent.textContent).toContain("Deleted3");
    expect(recent.textContent).toContain("opaque-persisted-cursor");
    expect(recent.textContent).toContain("public retry note");
    expect(
      fetch.mock.calls
        .map(requestFor)
        .some(
          (request) =>
            request.method === "GET" &&
            request.url.endsWith("/v1/admin/gc/runs?kind=r2-orphans&limit=10"),
        ),
    ).toBe(true);
  });

  it("keeps a completed run when the pre-run history response resolves late", async () => {
    const { fake } = adminFixture();
    const initialHistory = deferredResponse();
    let historyRequests = 0;
    const fetch = vi.fn<StashFetch>((...args) => {
      const request = requestFor(args);
      if (request.method === "GET" && request.url.includes("/v1/admin/gc/runs")) {
        historyRequests += 1;
        if (historyRequests === 1) return initialHistory.promise;
      }
      return fake.fetch(...args);
    });
    const client = createStashClient({ baseUrl: "https://fake.invalid", token: ADMIN, fetch });
    renderPanel(client);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Run" }));
    const current = await screen.findByRole("region", { name: "Current run" });
    const completedRunId = within(current).getByText("Run ID").nextElementSibling?.textContent;
    expect(completedRunId).toBeTruthy();
    await waitFor(() => expect(historyRequests).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("region", { name: `Run ${completedRunId}` })).toBeTruthy();

    await act(async () => {
      initialHistory.resolve(jsonResponse({ runs: [] }));
      await initialHistory.promise;
    });
    expect(screen.getByRole("region", { name: `Run ${completedRunId}` })).toBeTruthy();
  });

  it("clears old-kind rows and errors before the next kind history resolves", async () => {
    const { fake } = adminFixture();
    fake.state.gcRuns.push(persistedRun({ error: null }));
    const ledgerHistory = deferredResponse();
    let r2HistoryRequests = 0;
    let ledgerHistoryRequests = 0;
    const fetch = vi.fn<StashFetch>((...args) => {
      const request = requestFor(args);
      if (request.method === "GET" && request.url.includes("/v1/admin/gc/runs")) {
        if (request.url.includes("kind=ledger")) {
          ledgerHistoryRequests += 1;
          return ledgerHistory.promise;
        }
        r2HistoryRequests += 1;
        if (r2HistoryRequests === 2) {
          return Promise.resolve(
            jsonResponse(
              { error: { code: "internal", message: "History temporarily unavailable." } },
              500,
            ),
          );
        }
      }
      return fake.fetch(...args);
    });
    const client = createStashClient({ baseUrl: "https://fake.invalid", token: ADMIN, fetch });
    renderPanel(client);
    const user = userEvent.setup();

    expect(await screen.findByRole("region", { name: "Run persisted-run" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Could not load recent runs")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Run persisted-run" })).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "ledger");
    await waitFor(() => expect(ledgerHistoryRequests).toBe(1));
    expect(screen.queryByRole("region", { name: "Run persisted-run" })).toBeNull();
    expect(screen.queryByText("Could not load recent runs")).toBeNull();
    expect(screen.getByText("Loading recent runs…")).toBeTruthy();
  });

  it("offers content collection and sends the selected kind", async () => {
    const { client, fetch } = adminFixture();
    renderPanel(client);
    const user = userEvent.setup();
    const kind = await screen.findByRole("combobox", { name: "Kind" });

    expect(
      within(kind)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["r2-orphans", "ledger", "content"]);
    await user.selectOptions(kind, "content");
    await user.click(await screen.findByRole("button", { name: "Run" }));
    await screen.findByRole("region", { name: "Current run" });

    const runRequest = fetch.mock.calls
      .map(requestFor)
      .find((request) => request.method === "POST" && request.url.endsWith("/v1/admin/gc"));
    expect(runRequest).toBeDefined();
    expect(await runRequest!.json()).toMatchObject({ kind: "content" });
  });

  it("renders nothing and makes no GC calls for a non-admin principal", async () => {
    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("notes");
    const token = await fake.mintToken("notes", "read");
    const gcRequests: Request[] = [];
    const fetch = vi.fn<StashFetch>((...args) => {
      const request = requestFor(args);
      if (request.url.includes("/v1/admin/gc")) gcRequests.push(request);
      return fake.fetch(...args);
    });
    const client = createStashClient({ baseUrl: "https://fake.invalid", token, fetch });
    renderPanel(client);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Maintenance" })).toBeNull();
    expect(gcRequests).toHaveLength(0);
  });

  it("renders nothing and makes no GC calls while capability resolution is pending", async () => {
    const fetch = vi.fn<StashFetch>(() => new Promise<Response>(() => {}));
    const client = createStashClient({ baseUrl: "https://fake.invalid", token: ADMIN, fetch });
    renderPanel(client);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Maintenance" })).toBeNull();
    expect(
      fetch.mock.calls.map(requestFor).filter((request) => request.url.includes("/v1/admin/gc")),
    ).toHaveLength(0);
  });
});
