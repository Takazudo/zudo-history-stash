import { createStashClient, type StashFetch } from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditWorkbench, StashUiProvider } from "@takazudo/zudo-history-stash-ui";
import "@takazudo/zudo-history-stash-ui/styles.css";

const BASE_URL = "https://edit-overflow.test";
const ADMIN_TOKEN = "edit-overflow-admin";
const STASH = "notes";
const PATH = "docs/a-very-long-workbench-path-that-must-wrap-without-growing-the-page.txt";
const LONG_LINE = "long-candidate-line-".repeat(160);

let mountedRoot: Root | null = null;

function withSignal(fetch: StashFetch, signal: AbortSignal): StashFetch {
  return (input, init) => fetch(input, init?.signal ? init : { ...init, signal });
}

async function seedHarness() {
  const fake = createFakeStash({ adminToken: ADMIN_TOKEN });
  fake.createStash(STASH);
  const client = createStashClient({ baseUrl: BASE_URL, token: ADMIN_TOKEN, fetch: fake.fetch });
  const first = await client.files(STASH).put(PATH, {
    body: `first version\n${LONG_LINE}before\n`,
    expectedVersion: null,
    author: "Overflow fixture",
    message: "Create fixture",
  });
  if (!first.ok) throw new Error(first.error.message);
  const second = await client.files(STASH).put(PATH, {
    body: `second version\n${LONG_LINE}after\n`,
    expectedVersion: first.value.version,
    author: "Overflow fixture",
    message: "Update fixture",
  });
  if (!second.ok) throw new Error(second.error.message);
  return { client, fake };
}

export async function mountEditWorkbenchOverflowHarness(): Promise<void> {
  const fixture = await seedHarness();
  mountedRoot?.unmount();
  document.querySelector("#zhs-edit-overflow-harness")?.remove();

  const appRoot = document.querySelector<HTMLElement>("#root");
  if (appRoot !== null) appRoot.hidden = true;

  const harness = document.createElement("div");
  harness.id = "zhs-edit-overflow-harness";
  harness.style.blockSize = "100dvh";
  harness.style.minInlineSize = "0";
  document.body.append(harness);

  const clientForSignal = (signal: AbortSignal) =>
    createStashClient({
      baseUrl: BASE_URL,
      token: ADMIN_TOKEN,
      fetch: withSignal(fixture.fake.fetch, signal),
    });

  mountedRoot = createRoot(harness);
  mountedRoot.render(
    <StrictMode>
      <StashUiProvider client={fixture.client} clientForSignal={clientForSignal}>
        <EditWorkbench initialSource={1} path={PATH} stash={STASH} />
      </StashUiProvider>
    </StrictMode>,
  );
}
