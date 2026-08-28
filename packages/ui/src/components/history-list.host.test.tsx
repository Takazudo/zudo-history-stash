import { createStashClient } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useFileHistory } from "../hooks/use-file-history.js";
import { defaultStashHref } from "../provider/routes.js";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import type { StashAnchorProps, StashHrefFor } from "../provider/types.js";
import { HistoryList } from "./history-list.js";

const stash = "team-notes";
const path = "docs/read-me.txt";
const adminToken = "host-admin";
const fake = createFakeStash({ adminToken });
fake.createStash(stash);
const client = createStashClient({
  baseUrl: "https://fake.invalid",
  token: adminToken,
  fetch: fake.fetch,
});

function HostAnchor({ children, href, ...props }: StashAnchorProps) {
  return (
    <a {...props} href={href} data-host-anchor="true">
      {children}
    </a>
  );
}

function HistoryHost() {
  const history = useFileHistory(stash, path);
  if (history.state === "loading") return <p>Host loading</p>;
  if (history.state === "error") throw history.error;
  return (
    <HistoryList
      loadMoreError={history.loadMoreError}
      loadingMore={history.loadingMore}
      page={history.page}
      path={path}
      stash={stash}
      onLoadMore={history.loadMore}
    />
  );
}

describe("fake-backed HistoryList host bridge", () => {
  beforeAll(async () => {
    const files = client.files(stash);
    await files.put(path, {
      body: "first\n",
      expectedVersion: null,
      author: "Ada",
      message: "first",
    });
    await files.put(path, {
      body: "second\n",
      expectedVersion: 1,
      author: "Grace",
      message: "second",
    });
  });

  it("renders the hook page and delegates every package link to hrefFor and Anchor", async () => {
    const hrefFor = vi.fn<StashHrefFor>((route) => `host:${defaultStashHref(route)}`);
    render(
      <StashUiProvider client={client} Anchor={HostAnchor} hrefFor={hrefFor}>
        <HistoryHost />
      </StashUiProvider>,
    );

    const historyTable = await screen.findByRole("table");
    const newestRow = historyTable.querySelector('[data-history-version="2"]');
    expect(newestRow).toBeTruthy();
    const row = within(newestRow as HTMLElement);
    const view = row.getByRole("link", { name: "View this version" });
    const diff = row.getByRole("link", { name: "Diff vs head" });
    expect(view.dataset.hostAnchor).toBe("true");
    expect(diff.dataset.hostAnchor).toBe("true");
    expect(view.getAttribute("href")).toBe("host:/s/team-notes/f/docs/read-me.txt?version=2");
    expect(diff.getAttribute("href")).toBe(
      "host:/s/team-notes/diff/docs/read-me.txt?from=2&to=head",
    );
    expect(hrefFor).toHaveBeenCalledWith({
      kind: "file",
      stash,
      path,
      version: 2,
    });
    expect(hrefFor).toHaveBeenCalledWith({
      kind: "diff",
      stash,
      path,
      from: 2,
      to: "head",
    });
  });

  it("synchronously discards an open rollback when the history target changes", async () => {
    const nextPath = "docs/transition.txt";
    const files = client.files(stash);
    await files.put(nextPath, {
      body: "next target\n",
      expectedVersion: null,
      author: "Lin",
      message: "next target",
    });
    const originalResult = await files.history(path);
    const nextResult = await files.history(nextPath);
    if (!originalResult.ok || !nextResult.ok) throw new Error("Missing history fixture");
    const rendered = render(
      <StashUiProvider client={client}>
        <HistoryList page={originalResult.value} path={path} stash={stash} onLoadMore={vi.fn()} />
      </StashUiProvider>,
    );

    const rollback = screen.getByRole("button", { name: "Rollback to v1" });
    await waitFor(() => expect(rollback.hasAttribute("disabled")).toBe(false));
    await userEvent.click(rollback);
    expect(screen.getByRole("dialog")).toBeTruthy();

    rendered.rerender(
      <StashUiProvider client={client}>
        <HistoryList page={nextResult.value} path={nextPath} stash={stash} onLoadMore={vi.fn()} />
      </StashUiProvider>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Compare" }).getAttribute("href")).toContain(
      "docs/transition.txt",
    );
  });
});
