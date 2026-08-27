import { createStashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { DeleteStashDialog } from "./delete-stash-dialog.js";

const NOW = Date.parse("2026-08-27T00:00:00.000Z");
const ADMIN = "test-admin";

function requestFor(call: Parameters<StashFetch>): Request {
  return new Request(call[0], call[1]);
}

describe("DeleteStashDialog", () => {
  it("shows the server deadline and permanent token consequences before reporting completion", async () => {
    const fake = createFakeStash({ adminToken: ADMIN, now: () => NOW, deleteGraceDays: 30 });
    fake.createStash("notes");
    const formerToken = await fake.mintToken("notes", "write");
    const fetch = vi.fn<StashFetch>(fake.fetch);
    const client = createStashClient({ baseUrl: "https://fake.invalid", token: ADMIN, fetch });
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(
      <StashUiProvider client={client}>
        <DeleteStashDialog open stash="notes" onClose={onClose} onDeleted={onDeleted} />
      </StashUiProvider>,
    );
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: /Delete/ });

    expect(dialog.textContent).toContain("hides the stash");
    expect(dialog.textContent).toContain("complete file history remain stored");
    expect(dialog.textContent).toContain("cannot be reused after a restore");
    await user.click(within(dialog).getByRole("button", { name: "Delete stash" }));

    const restoreUntil = new Date(NOW + 30 * 86_400_000).toISOString();
    await waitFor(() => expect(dialog.textContent).toContain(restoreUntil));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("former tokens remain revoked");
    expect(dialog.textContent).toContain("cannot be reused after restore");
    expect(fake.state.stashes.get("notes")?.deletedAt).toBe(NOW);
    expect([...fake.state.tokens.values()][0]?.revokedAt).toBe(NOW);

    const formerResponse = await fake.fetch("https://fake.invalid/v1/me", {
      headers: { Authorization: `Bearer ${formerToken}` },
    });
    expect(formerResponse.status).toBe(401);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ restoreUntil }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing and never invokes deletion for unresolved or non-admin principals", async () => {
    const deleteRequests: Request[] = [];
    const pendingClient = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "pending",
      fetch: (...args) => {
        const request = requestFor(args);
        if (request.method === "DELETE") deleteRequests.push(request);
        return new Promise<Response>(() => undefined);
      },
    });
    const pending = render(
      <StashUiProvider client={pendingClient}>
        <DeleteStashDialog open stash="notes" onClose={vi.fn()} onDeleted={vi.fn()} />
      </StashUiProvider>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    pending.unmount();

    const fake = createFakeStash({ adminToken: ADMIN });
    fake.createStash("notes");
    const stashToken = await fake.mintToken("notes", "write");
    const fetch = vi.fn<StashFetch>((...args) => {
      const request = requestFor(args);
      if (request.method === "DELETE") deleteRequests.push(request);
      return fake.fetch(...args);
    });
    const client = createStashClient({ baseUrl: "https://fake.invalid", token: stashToken, fetch });
    render(
      <StashUiProvider client={client}>
        <DeleteStashDialog open stash="notes" onClose={vi.fn()} onDeleted={vi.fn()} />
      </StashUiProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deleteRequests).toHaveLength(0);
  });
});
