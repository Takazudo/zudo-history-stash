import {
  createStashClient,
  type ProposalRecord,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createFakeStash, type FakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { ProposalReview, type ProposalReviewProps } from "./proposal-review.js";

const STASH = "notes";
const PATH = "docs/readme.txt";
const BASE_URL = "https://proposal-review.test";
const DAY_MS = 86_400_000;

interface ReviewFixture {
  fake: FakeStash;
  client: StashClient;
  proposal: ProposalRecord;
  clock: { now: number };
}

async function createFixture(): Promise<ReviewFixture> {
  const adminToken = `proposal-review-admin-${globalThis.crypto.randomUUID()}`;
  const clock = { now: Date.parse("2026-08-28T00:00:00.000Z") };
  const fake = createFakeStash({ adminToken, now: () => clock.now });
  fake.createStash(STASH);
  const client = createStashClient({ baseUrl: BASE_URL, token: adminToken, fetch: fake.fetch });
  const seeded = await client.files(STASH).put(PATH, {
    body: "base line\nshared line\n",
    expectedVersion: null,
    author: "Fixture",
    message: "Seed base",
  });
  if (!seeded.ok) throw new Error(seeded.error.message);
  const created = await client.proposals(STASH).create({
    path: PATH,
    body: "candidate line\nshared line\n",
    baseVersion: 1,
    author: "Review Bot",
    message: "Update the first line",
  });
  if (!created.ok) throw new Error(created.error.message);
  return { fake, client, proposal: created.value, clock };
}

function renderReview(
  client: StashClient,
  proposalId: string,
  callbacks: {
    onApproved?: NonNullable<ProposalReviewProps["onApproved"]>;
    onRejected?: NonNullable<ProposalReviewProps["onRejected"]>;
  } = {},
  clientForSignal: (signal: AbortSignal) => StashClient = () => client,
) {
  return render(
    <StashUiProvider client={client} clientForSignal={clientForSignal}>
      <ProposalReview
        proposalId={proposalId}
        stash={STASH}
        onApproved={callbacks.onApproved}
        onRejected={callbacks.onRejected}
      />
    </StashUiProvider>,
  );
}

async function readyReview(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: PATH });
  return screen.findByRole("table", { name: "Unified diff" });
}

async function approveFromReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Approve…" }));
  const dialog = await screen.findByRole("dialog", { name: `Approve ${PATH}` });
  expect(dialog.textContent).toContain(
    "Applies as v2 on top of v1 · a normal put version linked to this proposal",
  );
  await user.click(within(dialog).getByRole("button", { name: "Approve proposal" }));
}

describe("ProposalReview", () => {
  it("approves through the fake and renders the closed decision record", async () => {
    const fixture = await createFixture();
    const onApproved = vi.fn();
    renderReview(fixture.client, fixture.proposal.id, { onApproved });
    const diff = await readyReview();
    expect(diff.textContent).toContain("base line");
    expect(diff.textContent).toContain("candidate line");
    expect(screen.getByText("Base → candidate")).toBeTruthy();

    await approveFromReview(userEvent.setup());
    await waitFor(() => expect(onApproved).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Decision record" })).toBeTruthy();
    expect(screen.getAllByLabelText("Proposal status: applied")).toHaveLength(2);
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByRole("link", { name: "v2" }).getAttribute("href")).toBe(
      `/s/${STASH}/f/${PATH}?version=2`,
    );
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();

    const applied = await fixture.client.files(STASH).get(PATH, { version: 2 });
    expect(applied.ok && !("notModified" in applied) && applied.value.meta).toEqual({
      proposalId: fixture.proposal.id,
    });
  });

  it("keeps the immutable diff, shows the exact stale banner, and disables approval", async () => {
    const fixture = await createFixture();
    renderReview(fixture.client, fixture.proposal.id);
    const diff = await readyReview();
    const before = diff.textContent;
    const moved = await fixture.client.files(STASH).put(PATH, {
      body: "moved head\n",
      expectedVersion: 1,
      author: "Grace",
      message: "Move head",
    });
    if (!moved.ok) throw new Error(moved.error.message);

    await approveFromReview(userEvent.setup());
    const staleCopy =
      "Head moved to v2 by Grace — this proposal was written against v1; approving would refuse";
    expect(
      await screen.findByText(
        (_, element) => element?.tagName === "STRONG" && element.textContent === staleCopy,
      ),
    ).toBeTruthy();
    const approve = screen.getByRole("button", { name: "Approve…" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(approve.getAttribute("title")).toBe("Approval is disabled because the head moved");
    expect(screen.getByRole("table", { name: "Unified diff" }).textContent).toBe(before);
    expect(screen.getByRole("table", { name: "Unified diff" }).textContent).not.toContain(
      "moved head",
    );
    const history = await fixture.client.files(STASH).history(PATH);
    expect(history.ok && history.value.headVersion).toBe(2);
  });

  it("refreshes a proposal that closed before approval and shows its decision", async () => {
    const fixture = await createFixture();
    renderReview(fixture.client, fixture.proposal.id);
    await readyReview();
    const rejected = await fixture.client
      .proposals(STASH)
      .reject(fixture.proposal.id, { reason: "Already closed" });
    if (!rejected.ok) throw new Error(rejected.error.message);

    await approveFromReview(userEvent.setup());
    expect(await screen.findByText("Already closed")).toBeTruthy();
    expect(screen.getAllByLabelText("Proposal status: rejected")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
  });

  it("turns an approval-time expiry into a disabled state while retaining rejection", async () => {
    const fixture = await createFixture();
    renderReview(fixture.client, fixture.proposal.id);
    await readyReview();
    fixture.clock.now += 14 * DAY_MS;

    await approveFromReview(userEvent.setup());
    expect(
      await screen.findByText("This proposal has expired. Approval is disabled."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reject…" })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reject…" }));
    const dialog = await screen.findByRole("dialog", { name: `Reject ${PATH}` });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reason (optional)" }),
      "Expired cleanup",
    );
    await user.click(within(dialog).getByRole("button", { name: "Reject proposal" }));
    expect(await screen.findByText("Expired cleanup")).toBeTruthy();
    expect(screen.getAllByLabelText("Proposal status: rejected")).toHaveLength(2);
  });

  it("rejects with a reason without changing the file head", async () => {
    const fixture = await createFixture();
    const onRejected = vi.fn();
    renderReview(fixture.client, fixture.proposal.id, { onRejected });
    await readyReview();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reject…" }));
    const dialog = await screen.findByRole("dialog", { name: `Reject ${PATH}` });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Reason (optional)" }),
      "Superseded by a clearer draft",
    );
    await user.click(within(dialog).getByRole("button", { name: "Reject proposal" }));

    await waitFor(() => expect(onRejected).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Superseded by a clearer draft")).toBeTruthy();
    const history = await fixture.client.files(STASH).history(PATH);
    expect(history.ok && history.value.headVersion).toBe(1);
  });

  it("shows no write affordances and issues no mutation for a read principal", async () => {
    const fixture = await createFixture();
    const readToken = await fixture.fake.mintToken(STASH, "read");
    const fetch = vi.fn<StashFetch>(fixture.fake.fetch);
    const readClient = createStashClient({ baseUrl: BASE_URL, token: readToken, fetch });
    const clientForSignal = vi.fn(() => readClient);
    renderReview(readClient, fixture.proposal.id, {}, clientForSignal);
    await readyReview();
    await waitFor(() => expect(clientForSignal).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Approve…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();
    expect(
      fetch.mock.calls.every(([input, init]) => new Request(input, init).method === "GET"),
    ).toBe(true);
  });
});
