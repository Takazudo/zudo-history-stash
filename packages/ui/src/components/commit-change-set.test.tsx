import {
  createStashClient,
  type ChangeItem,
  type ChangeSetRecord,
  type CommitRecord,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { useOpenChangeSetCount } from "../hooks/use-open-change-set-count.js";
import { ChangeSetList } from "./change-set-list.js";
import { ChangeSetReview } from "./change-set-review.js";
import { CommitDetail } from "./commit-detail.js";
import { CommitList } from "./commit-list.js";
import { ChangesList } from "./change-row.js";
import { RevertCommitDialog } from "./revert-commit-dialog.js";

const now = "2026-08-29T00:00:00.000Z";
function record(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return {
    id: "cmt_1",
    stash: "notes",
    source: "viewer",
    sourceId: null,
    author: "Ada",
    message: "Atomic edit",
    meta: {},
    entryCount: 3,
    firstChangeId: 1,
    lastChangeId: 3,
    revertsCommitId: null,
    createdBy: "admin",
    createdAt: now,
    entries: [],
    ...overrides,
  };
}
function changeSet(overrides: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: "chs_1",
    stash: "notes",
    status: "open",
    author: "Ada",
    message: "Review me",
    meta: {},
    expiresAt: "2026-09-01T00:00:00.000Z",
    createdBy: "admin",
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    commitId: null,
    entries: [{ path: "a.txt", op: "put", baseVersion: 1, current: null, stale: true }],
    ...overrides,
  };
}
function client() {
  const fake = createFakeStash({ adminToken: "admin" });
  fake.createStash("notes");
  return createStashClient({ baseUrl: "https://fake.invalid", token: "admin", fetch: fake.fetch });
}

describe("commit and change-set surfaces", () => {
  it("renders commit metadata, paths, source, and revert relationship links", () => {
    const commit = record({ revertsCommitId: "cmt_old" });
    render(
      <StashUiProvider client={client()}>
        <CommitList
          stash="notes"
          page={{ commits: [commit], total: 1, nextAfter: null }}
          pathsByCommit={{ cmt_1: ["a.txt", "b.txt"] }}
        />
      </StashUiProvider>,
    );
    expect(screen.getByText("Atomic edit").getAttribute("href")).toBe("/s/notes/commits/cmt_1");
    expect(screen.getByText("viewer")).toBeTruthy();
    expect(screen.getByText("3 entries")).toBeTruthy();
    expect(screen.getByText("cmt_old").getAttribute("href")).toBe("/s/notes/commits/cmt_old");
  });

  it("filters change sets including expired and exposes stale path metadata", async () => {
    const onStatusChange = vi.fn();
    const onPathChange = vi.fn();
    render(
      <StashUiProvider client={client()}>
        <ChangeSetList
          stash="notes"
          page={{ changeSets: [changeSet()], total: 1, nextAfter: null }}
          status="open"
          path=""
          onStatusChange={onStatusChange}
          onPathChange={onPathChange}
        />
      </StashUiProvider>,
    );
    await userEvent.selectOptions(screen.getByLabelText("Change set status"), "expired");
    await userEvent.type(screen.getByLabelText("Filter by path"), "a.txt");
    expect(onStatusChange).toHaveBeenCalledWith("expired");
    expect(onPathChange.mock.calls.map(([value]) => value).join("")).toBe("a.txt");
    expect(screen.getByText("stale")).toBeTruthy();
  });

  it("folds exactly three adjacent entries from one commit into one row with three children", () => {
    const changes: ChangeItem[] = [1, 2, 3].map((changeId) => ({
      changeId,
      commitId: "cmt_atomic",
      stash: "notes",
      path: `${changeId}.txt`,
      version: 1,
      kind: "put",
      author: "Ada",
      message: "batch",
      size: changeId,
      createdAt: now,
    }));
    render(
      <StashUiProvider client={client()}>
        <ChangesList changes={changes} />
      </StashUiProvider>,
    );
    const group = screen.getByText("3 changes in commit cmt_atomic").closest("li");
    expect(group).toBeTruthy();
    expect(within(group as HTMLElement).getAllByRole("listitem")).toHaveLength(3);
    expect(within(group as HTMLElement).getAllByText("Commit cmt_atomic")).toHaveLength(3);
  });

  it("loads all inline commit diffs with one page request", async () => {
    const fake = createFakeStash({ adminToken: "admin" });
    fake.createStash("notes");
    const baseClient = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fake.fetch,
    });
    const created = await baseClient.commits("notes").create({
      entries: [
        { op: "put", path: "a.txt", expectedVersion: null, body: "a\n" },
        { op: "put", path: "b.txt", expectedVersion: null, body: "b\n" },
      ],
      author: "Ada",
      message: "two",
      meta: {},
    });
    if (!created.ok) throw created;
    let diffRequests = 0;
    const counting = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: async (input, init) => {
        if (String(input).includes(`/commits/${created.value.id}/diff`)) diffRequests += 1;
        return fake.fetch(input, init);
      },
    });
    render(
      <StashUiProvider client={counting}>
        <CommitDetail stash="notes" commit={created.value} />
      </StashUiProvider>,
    );
    await waitFor(() => expect(screen.getAllByText(/created/)).toHaveLength(2));
    expect(diffRequests).toBe(1);
  });

  it("rejects a change set once and replaces actions with its immutable decision record", async () => {
    const fake = createFakeStash({ adminToken: "admin" });
    fake.createStash("notes");
    const sdk = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fake.fetch,
    });
    const created = await sdk.changeSets("notes").create({
      entries: [{ op: "put", path: "review.txt", baseVersion: null, body: "candidate\n" }],
      author: "Ada",
      message: "review",
      meta: {},
    });
    if (!created.ok) throw created;
    const onDecision = vi.fn();
    render(
      <StashUiProvider client={sdk}>
        <ChangeSetReview stash="notes" changeSet={created.value} onDecision={onDecision} />
      </StashUiProvider>,
    );
    await screen.findByRole("table", { name: "Unified diff" });
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Reason (optional)"), "needs work");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await screen.findByText("Decision: rejected");
    expect(screen.getByText("needs work")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", decisionReason: "needs work" }),
    );
  });

  it("previews every current head before reverting an atomic commit", async () => {
    const fake = createFakeStash({ adminToken: "admin" });
    fake.createStash("notes");
    const sdk = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fake.fetch,
    });
    const created = await sdk.commits("notes").create({
      entries: [
        { op: "put", path: "a.txt", expectedVersion: null, body: "a\n" },
        { op: "put", path: "b.txt", expectedVersion: null, body: "b\n" },
      ],
      author: "Ada",
      message: "two",
      meta: {},
    });
    if (!created.ok) throw created;
    const onSuccess = vi.fn();
    render(
      <StashUiProvider client={sdk}>
        <RevertCommitDialog
          stash="notes"
          commit={created.value}
          onClose={vi.fn()}
          onSuccess={onSuccess}
        />
      </StashUiProvider>,
    );
    const preview = await screen.findByRole("list", { name: "Current head preview" });
    expect(within(preview).getAllByText(/head v1/)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Revert commit" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ revertsCommitId: created.value.id, entryCount: 2 }),
    );
  });

  it("reads the authoritative open change-set total with a one-row query", async () => {
    const fake = createFakeStash({ adminToken: "admin" });
    fake.createStash("notes");
    const sdk = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fake.fetch,
    });
    await sdk.changeSets("notes").create({
      entries: [{ op: "put", path: "one.txt", baseVersion: null, body: "one" }],
      author: "Ada",
      message: "one",
      meta: {},
    });
    function Count() {
      const result = useOpenChangeSetCount("notes");
      return <p>{result.state === "ready" ? result.value : result.state}</p>;
    }
    render(
      <StashUiProvider client={sdk}>
        <Count />
      </StashUiProvider>,
    );
    expect(await screen.findByText("1")).toBeTruthy();
  });
});
