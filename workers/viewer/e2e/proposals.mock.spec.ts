import type { Page, Request } from "@playwright/test";
import { expect, test } from "./fixtures/console-errors.js";

const STASH = "notes";
const PATH = "docs/proposal.md";
const PROPOSAL_ID = "prp_1787880000000abcdef12";
const PROPOSAL_ROUTE = `/api/v1/stashes/${STASH}/proposals/${PROPOSAL_ID}`;
const BASE_HASH = `sha256-${"a".repeat(64)}`;
const CANDIDATE_HASH = `sha256-${"b".repeat(64)}`;
const MOVED_HASH = `sha256-${"c".repeat(64)}`;
const REJECTION_REASON = "Superseded by a clearer draft";

type FixtureMode = "approve" | "stale" | "reject";
type FixtureStatus = "open" | "applied" | "rejected";

const tokenScript = () => sessionStorage.setItem("zhs.token", "zhs_test");

function jsonBody(request: Request): unknown {
  const body = request.postData();
  return body === null ? null : (JSON.parse(body) as unknown);
}

function proposalRecord(status: FixtureStatus) {
  const terminal = status !== "open";
  return {
    id: PROPOSAL_ID,
    stash: STASH,
    path: PATH,
    baseVersion: 1,
    author: "Proposal Bot",
    message: "Review the candidate line",
    meta: { lane: "mock-review", proposalId: PROPOSAL_ID },
    size: 15,
    hash: CANDIDATE_HASH,
    createdAt: "2026-08-28T01:00:00.000Z",
    expiresAt: "2026-09-11T01:00:00.000Z",
    status,
    decidedAt: terminal ? "2026-08-28T02:00:00.000Z" : null,
    decidedBy: terminal ? "admin" : null,
    decisionReason: status === "rejected" ? REJECTION_REASON : null,
    appliedVersion: status === "applied" ? 2 : null,
    appliedChangeId: status === "applied" ? 42 : null,
    body: "candidate line\n",
  };
}

function proposalDiff() {
  return {
    state: "ready",
    unified:
      "===================================================================\n--- base\n+++ candidate\n@@ -1,1 +1,1 @@\n-base line\n+candidate line\n",
    truncated: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-base line", "+candidate line"],
      },
    ],
    stats: { added: 1, removed: 1 },
    base: { version: 1, hash: BASE_HASH, deleted: false },
    candidate: { hash: CANDIDATE_HASH, size: 15 },
    current: {
      version: 1,
      hash: BASE_HASH,
      deleted: false,
      kind: "put",
      author: "Seed Author",
      createdAt: "2026-08-28T00:00:00.000Z",
    },
    stale: false,
  };
}

async function installFixture(page: Page, mode: FixtureMode) {
  const approvalRequests: unknown[] = [];
  const rejectionRequests: unknown[] = [];
  const unexpectedRequests: string[] = [];
  const pageErrors: string[] = [];
  let status: FixtureStatus = "open";
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const signature = `${request.method()} ${url.pathname}${url.search}`;

    if (request.method() === "GET" && url.pathname === "/api/v1/me" && url.search === "") {
      await route.fulfill({ status: 200, json: { principal: "admin" } });
      return;
    }

    if (request.method() === "GET" && url.pathname === PROPOSAL_ROUTE && url.search === "") {
      await route.fulfill({ status: 200, json: proposalRecord(status) });
      return;
    }

    if (
      request.method() === "GET" &&
      url.pathname === `${PROPOSAL_ROUTE}/diff` &&
      url.search === ""
    ) {
      await route.fulfill({ status: 200, json: proposalDiff() });
      return;
    }

    if (
      request.method() === "POST" &&
      url.pathname === `${PROPOSAL_ROUTE}/approve` &&
      url.search === ""
    ) {
      approvalRequests.push(jsonBody(request));
      if (mode === "approve") {
        status = "applied";
        await route.fulfill({
          status: 200,
          json: {
            status: "applied",
            appliedVersion: 2,
            appliedChangeId: 42,
            hash: CANDIDATE_HASH,
            createdAt: "2026-08-28T02:00:00.000Z",
          },
        });
        return;
      }
      if (mode === "stale") {
        await route.fulfill({
          status: 409,
          json: {
            error: { code: "stale", message: "The file head changed." },
            current: {
              version: 2,
              hash: MOVED_HASH,
              deleted: false,
              kind: "put",
              author: "Grace",
              createdAt: "2026-08-28T02:00:00.000Z",
            },
          },
        });
        return;
      }
    }

    if (
      request.method() === "POST" &&
      url.pathname === `${PROPOSAL_ROUTE}/reject` &&
      url.search === ""
    ) {
      rejectionRequests.push(jsonBody(request));
      if (mode === "reject") {
        status = "rejected";
        await route.fulfill({ status: 200, json: proposalRecord(status) });
        return;
      }
    }

    unexpectedRequests.push(signature);
    await route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: `Unexpected mock request: ${signature}` } },
    });
  });

  return { approvalRequests, rejectionRequests, unexpectedRequests, pageErrors };
}

async function openReview(page: Page, mode: FixtureMode) {
  await page.addInitScript(tokenScript);
  const fixture = await installFixture(page, mode);
  await page.goto(`/s/${STASH}/proposals/${PROPOSAL_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: PATH })).toBeVisible();
  const diff = page.getByRole("table", { name: "Unified diff" });
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("base line");
  await expect(diff).toContainText("candidate line");
  return { ...fixture, diff };
}

test("@smoke proposal review approves and renders the applied decision record", async ({
  page,
}) => {
  const fixture = await openReview(page, "approve");

  await page.getByRole("button", { name: "Approve…" }).click();
  const dialog = page.getByRole("dialog", { name: `Approve ${PATH}` });
  await expect(dialog).toContainText(
    "Applies as v2 on top of v1 · a normal put version linked to this proposal",
  );
  await dialog.getByRole("button", { name: "Approve proposal", exact: true }).click();

  const decision = page.getByRole("region", { name: "Decision record" });
  await expect(decision).toBeVisible();
  await expect(page.getByLabel("Proposal status: applied")).toHaveCount(2);
  await expect(decision.getByText("admin", { exact: true })).toBeVisible();
  await expect(decision.getByRole("link", { name: "v2" })).toHaveAttribute(
    "href",
    `/s/${STASH}/f/${PATH}?version=2`,
  );
  expect(fixture.approvalRequests).toEqual([{}]);
  expect(fixture.rejectionRequests).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});

test.describe("stale proposal approval", () => {
  test.use({
    allowedConsoleErrors: [
      {
        pattern:
          /^Failed to load resource: the server responded with a status of 409(?: \(Conflict\))?$/u,
        why: "The stale proposal case deliberately routes the fenced approval to HTTP 409.",
      },
    ],
  });

  test("@smoke proposal review refuses a routed stale approval without changing its diff", async ({
    page,
  }) => {
    const fixture = await openReview(page, "stale");
    const immutableDiff = await fixture.diff.textContent();

    await page.getByRole("button", { name: "Approve…" }).click();
    const dialog = page.getByRole("dialog", { name: `Approve ${PATH}` });
    await dialog.getByRole("button", { name: "Approve proposal", exact: true }).click();

    await expect(
      page.getByText(
        "Head moved to v2 by Grace — this proposal was written against v1; approving would refuse",
        { exact: true },
      ),
    ).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve…" });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", "Approval is disabled because the head moved");
    await expect(fixture.diff).toHaveText(immutableDiff ?? "");
    await expect(fixture.diff).not.toContainText("moved head");
    expect(fixture.approvalRequests).toEqual([{}]);
    expect(fixture.rejectionRequests).toEqual([]);
    expect(fixture.unexpectedRequests).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });
});

test("@smoke proposal review rejects with a reason and no applied-version link", async ({
  page,
}) => {
  const fixture = await openReview(page, "reject");

  await page.getByRole("button", { name: "Reject…" }).click();
  const dialog = page.getByRole("dialog", { name: `Reject ${PATH}` });
  await dialog.getByRole("textbox", { name: "Reason (optional)" }).fill(REJECTION_REASON);
  await dialog.getByRole("button", { name: "Reject proposal", exact: true }).click();

  await expect(page.getByRole("region", { name: "Decision record" })).toBeVisible();
  await expect(page.getByLabel("Proposal status: rejected")).toHaveCount(2);
  await expect(page.getByText(REJECTION_REASON, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "v2" })).toHaveCount(0);
  expect(fixture.rejectionRequests).toEqual([{ reason: REJECTION_REASON }]);
  expect(fixture.approvalRequests).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});
