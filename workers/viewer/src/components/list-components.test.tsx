import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StashHttpError } from "@takazudo/zudo-history-stash";
import {
  Bytes,
  ChangeRow,
  KindBadge,
  PathCell,
  RelativeTime,
  StashUiProvider,
} from "@takazudo/zudo-history-stash-ui";
import { ViewerAnchor, viewerHrefFor } from "../app/viewer-stash-ui-provider.js";
import { change, createFakeViewerClient } from "../test/fake-viewer-client.js";
import { stashErrorMessage } from "./error-banner.js";

describe("shared list components", () => {
  it("renders kind with a sized icon, text, and rollback target", () => {
    const rendered = render(<KindBadge kind="rollback" rollbackOf={3} />);
    expect(rendered.container.querySelector(".zhs-kind-badge__icon")).toBeTruthy();
    expect(screen.getByText("rollback")).toBeTruthy();
    expect(screen.getByText("→ v3")).toBeTruthy();
  });

  it("renders exact bytes and relative time with absolute hover text", () => {
    render(
      <>
        <Bytes value={1234} />
        <RelativeTime value="2026-08-25T08:00:00.000Z" now={Date.parse("2026-08-25T09:00:00Z")} />
      </>,
    );
    expect(screen.getByText("1,234 B").getAttribute("title")).toBe("1,234 bytes");
    const time = screen.getByText("1 hour ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("title")).toBeTruthy();
  });

  it("links paths and change rows to the stable viewer URLs", () => {
    render(
      <MemoryRouter>
        <StashUiProvider
          Anchor={ViewerAnchor}
          client={createFakeViewerClient()}
          hrefFor={viewerHrefFor}
        >
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
            <ChangeRow change={change()} showStash />
          </ul>
        </StashUiProvider>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link", { name: "docs/readme.txt" })[0]?.getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt",
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByRole("link", { name: "notes" }).getAttribute("href")).toBe("/s/notes");
    expect(within(row).getByRole("link", { name: "Diff" }).getAttribute("href")).toBe(
      "/s/notes/diff/docs/readme.txt?from=1&to=2",
    );
  });

  it("maps thrown SDK HTTP errors and result-union failures to useful text", () => {
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
  });
});
