import { StashHttpError, createStashClient, type ChangeItem } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { defaultStashHrefFor } from "../provider/routes.js";
import type { StashAnchorProps, StashUiRoute } from "../provider/types.js";
import {
  Bytes,
  ChangeRow,
  ErrorBanner,
  KindBadge,
  LoadMore,
  PathCell,
  RelativeTime,
} from "../index.js";
import { clientValue, stashErrorMessage } from "./error-banner.js";

const change: ChangeItem = {
  changeId: 1,
  commitId: "legacy:1",
  stash: "notes",
  path: "docs/readme.txt",
  version: 2,
  kind: "put",
  author: "Ada",
  message: "Update readme",
  size: 120,
  createdAt: "2026-08-25T08:00:00.000Z",
};

function clientForTest() {
  const adminToken = "test-admin-token";
  const fake = createFakeStash({ adminToken });
  return createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    fetch: fake.fetch,
  });
}

function FakeAnchor({ children, href, ...props }: StashAnchorProps) {
  return (
    <a {...props} href={href} data-fake-anchor="true">
      {children}
    </a>
  );
}

describe("stateless components", () => {
  it("renders namespaced kind, byte, and time metadata", () => {
    const rendered = render(
      <>
        <KindBadge kind="rollback" rollbackOf={3} />
        <Bytes value={1234} />
        <RelativeTime value="2026-08-25T08:00:00.000Z" now={Date.parse("2026-08-25T09:00:00Z")} />
      </>,
    );

    expect(rendered.container.querySelector(".zhs-kind-badge--rollback svg")).toBeTruthy();
    expect(screen.getByText("→ v3")).toBeTruthy();
    expect(screen.getByText("1,234 B").className).toContain("zhs-bytes");
    expect(screen.getByText("1,234 B").getAttribute("title")).toBe("1,234 bytes");
    const time = screen.getByText("1 hour ago");
    expect(time.tagName).toBe("TIME");
    expect(time.className).toContain("zhs-relative-time");
    expect(time.getAttribute("title")).toBeTruthy();
  });

  it("routes PathCell and ChangeRow through the provider Anchor and hrefFor bridges", () => {
    const hrefFor = vi.fn((route: StashUiRoute) => defaultStashHrefFor(route));
    render(
      <StashUiProvider client={clientForTest()} Anchor={FakeAnchor} hrefFor={hrefFor}>
        <table>
          <tbody>
            <tr>
              <PathCell
                path="docs/readme.txt"
                route={{ kind: "file", stash: "notes", path: "docs/readme.txt" }}
              />
            </tr>
          </tbody>
        </table>
        <ul>
          <ChangeRow change={change} showStash />
        </ul>
      </StashUiProvider>,
    );

    const pathLinks = screen.getAllByRole("link", { name: "docs/readme.txt" });
    expect(pathLinks[0]?.getAttribute("href")).toBe("/s/notes/f/docs/readme.txt");
    expect(pathLinks[0]?.dataset.fakeAnchor).toBe("true");
    expect(pathLinks[0]?.querySelectorAll("wbr")).toHaveLength(1);

    const row = screen.getByRole("listitem");
    expect(row.className).toBe("zhs-change-row");
    expect(within(row).getByRole("link", { name: "notes" }).getAttribute("href")).toBe("/s/notes");
    expect(within(row).getByRole("link", { name: "Diff" }).getAttribute("href")).toBe(
      "/s/notes/diff/docs/readme.txt?from=1&to=2",
    );
    expect(hrefFor.mock.calls.map(([route]) => route)).toEqual([
      { kind: "file", stash: "notes", path: "docs/readme.txt" },
      { kind: "commit", stash: "notes", id: "legacy:1" },
      { kind: "stash", stash: "notes" },
      { kind: "file", stash: "notes", path: "docs/readme.txt" },
      { kind: "diff", stash: "notes", path: "docs/readme.txt", from: 1, to: 2 },
    ]);
  });

  it.each([
    ["deleted files", { ...change, kind: "delete" as const }],
    ["first versions", { ...change, version: 1 }],
  ])("does not offer a diff for %s", (_label, changeWithoutDiff) => {
    render(
      <ul>
        <ChangeRow change={changeWithoutDiff} Anchor={FakeAnchor} />
      </ul>,
    );

    expect(screen.queryByRole("link", { name: "Diff" })).toBeNull();
    expect(screen.getByRole("link", { name: "docs/readme.txt" })).toBeTruthy();
  });

  it("renders pure error states and leaves unauthorized side effects to the host", async () => {
    const onRetry = vi.fn();
    const rendered = render(<ErrorBanner error={new Error("offline")} onRetry={onRetry} />);

    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("zhs-error-banner");
    await userEvent.click(within(banner).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <ErrorBanner
        error={{ ok: false, error: { status: 401, code: "unauthorized", message: "Expired" } }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Session expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("maps SDK failures and unwraps successful ClientResult values", async () => {
    expect(
      stashErrorMessage(
        new StashHttpError(503, "internal", {
          error: { code: "internal", message: "D1 unavailable" },
        }),
      ),
    ).toBe("D1 unavailable");
    expect(
      stashErrorMessage({
        ok: false,
        error: { status: 409, code: "exists", message: "Conflict" },
      }),
    ).toBe("A stash with that name already exists.");
    expect(
      stashErrorMessage({
        ok: false,
        error: { status: 429, code: "rate-limited", message: "Try later" },
        retryAfter: Number.NaN,
      }),
    ).toBe("Try later");
    await expect(clientValue(Promise.resolve({ ok: true, value: 42 }))).resolves.toBe(42);
    await expect(
      clientValue(
        Promise.resolve({
          ok: false,
          error: { status: 503, code: "internal", message: "offline" },
        }),
      ),
    ).rejects.toMatchObject({ ok: false });
  });

  it("renders the shared rate-limit copy from a fake-injected ClientResult", async () => {
    const fake = createFakeStash({
      rateLimit: () => ({ success: false }),
    });
    fake.createStash("notes");
    const secret = await fake.mintToken("notes", "read");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: secret,
      fetch: fake.fetch,
    });
    const result = await client.me();
    if (result.ok) throw new Error("Expected the fake rate limiter to reject the request");

    render(<ErrorBanner error={result} />);

    expect(screen.getByText("Rate limited — try again in 60s")).toBeTruthy();
  });

  it("renders and disables the package Button primitive for pagination state", async () => {
    const onLoadMore = vi.fn();
    const rendered = render(<LoadMore hasMore loading={false} onLoadMore={onLoadMore} />);
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button.className).toContain("zhs-button--sm");
    await userEvent.click(button);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rendered.rerender(<LoadMore hasMore loading onLoadMore={onLoadMore} />);
    expect(screen.getByRole("button", { name: "Loading…" }).hasAttribute("disabled")).toBe(true);
    rendered.rerender(<LoadMore hasMore={false} loading={false} onLoadMore={onLoadMore} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
