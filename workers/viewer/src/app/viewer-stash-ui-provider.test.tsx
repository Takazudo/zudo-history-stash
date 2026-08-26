import {
  PathCell,
  useStashClient as useUiStashClient,
  useStashClientForSignal,
} from "@takazudo/zudo-history-stash-ui";
import type { StashClient } from "@takazudo/zudo-history-stash";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  StashClientProvider,
  type ViewerStashClientFactory,
} from "./auth/stash-client-provider.js";
import { TOKEN_STORAGE_KEY } from "./auth/token-store.js";
import { createFakeViewerClient } from "../test/fake-viewer-client.js";
import { ViewerStashUiProvider } from "./viewer-stash-ui-provider.js";

function BridgeProbe({
  expectedBoundClient,
  expectedClient,
  signal,
}: {
  expectedBoundClient: StashClient;
  expectedClient: StashClient;
  signal: AbortSignal;
}) {
  const client = useUiStashClient();
  const clientForSignal = useStashClientForSignal();
  const boundClient = clientForSignal(signal);
  return (
    <>
      <output
        data-bound-client={String(boundClient === expectedBoundClient)}
        data-client={String(client === expectedClient)}
      />
      <table>
        <tbody>
          <tr>
            <PathCell
              path="docs/readme.txt"
              route={{ kind: "file", stash: "notes", path: "docs/readme.txt", version: 3 }}
            />
          </tr>
        </tbody>
      </table>
    </>
  );
}

describe("ViewerStashUiProvider", () => {
  it("bridges the authenticated client, request signals, and React Router links", () => {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_test");
    const client = createFakeViewerClient();
    const boundClient = createFakeViewerClient();
    const withSignal = vi.fn(() => boundClient);
    client.withSignal = withSignal;
    const clientFactory: ViewerStashClientFactory = () => client;
    const controller = new AbortController();

    render(
      <MemoryRouter>
        <StashClientProvider clientFactory={clientFactory}>
          <ViewerStashUiProvider>
            <BridgeProbe
              expectedBoundClient={boundClient}
              expectedClient={client}
              signal={controller.signal}
            />
          </ViewerStashUiProvider>
        </StashClientProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").dataset.client).toBe("true");
    expect(screen.getByRole("status").dataset.boundClient).toBe("true");
    expect(withSignal).toHaveBeenCalledWith(controller.signal);
    expect(screen.getByRole("link", { name: "docs/readme.txt" }).getAttribute("href")).toBe(
      "/s/notes/f/docs/readme.txt?version=3",
    );
  });
});
