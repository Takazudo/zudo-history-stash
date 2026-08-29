import {
  createStashClient,
  type CapabilitiesResponse,
  type StashFilesClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import { BinaryUploadForm, defaultUploadRepresentation } from "./binary-upload-form.js";

const adminToken = "binary-upload-ui-admin";

function capabilities(
  overrides: Partial<CapabilitiesResponse["limits"]> = {},
): CapabilitiesResponse {
  return {
    representations: ["text", "binary"],
    contentAccess: ["inline", "raw", "deleted"],
    transferModes: ["json", "single", "multipart"],
    storageTiers: ["d1", "r2"],
    commitEntryKinds: ["put", "copy", "delete", "rollback"],
    limits: {
      jsonInlineMaxBytes: 16,
      d1InlineMaxBytes: 16,
      httpRequestMaxBytes: 100,
      singleUploadMaxBytes: 32,
      maxFileBytes: 256,
      diffMaxBytesPerSide: 16,
      multipartPartBytes: 8,
      maxMultipartParts: 10_000,
      maxOpenUploadSessionsPerStash: 32,
      maxReservedUploadBytesPerStash: 512,
      uploadSessionTtlSeconds: 600,
      ...overrides,
    },
  };
}

function renderUploadForm(
  capabilityOverrides: Partial<CapabilitiesResponse["limits"]> = {},
  onUploaded = vi.fn(),
) {
  const fake = createFakeStash({ adminToken, capabilities: capabilities(capabilityOverrides) });
  fake.createStash("notes");
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: adminToken,
    fetch: fake.fetch,
  });
  render(
    <StashUiProvider client={client}>
      <BinaryUploadForm onUploaded={onUploaded} stash="notes" />
    </StashUiProvider>,
  );
  return { fake, onUploaded };
}

describe("BinaryUploadForm", () => {
  it("shows one unavailable heading for a read-only principal", async () => {
    const fake = createFakeStash({ adminToken, capabilities: capabilities() });
    fake.createStash("notes");
    const readToken = await fake.mintToken("notes", "read");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: readToken,
      fetch: fake.fetch,
    });
    const principal = await client.me();
    expect(principal).toMatchObject({
      ok: true,
      value: { principal: "stash", stash: "notes", scope: "read" },
    });
    vi.spyOn(client, "me").mockResolvedValue(principal);
    render(
      <StashUiProvider client={client}>
        <BinaryUploadForm onUploaded={vi.fn()} stash="notes" />
      </StashUiProvider>,
    );

    expect(
      await screen.findAllByRole("heading", { name: "Raw upload is not available" }),
    ).toHaveLength(1);
  });

  it("labels cancellation without durable parts for a single upload", async () => {
    const fake = createFakeStash({ adminToken, capabilities: capabilities() });
    fake.createStash("notes");
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: adminToken,
      fetch: fake.fetch,
    });
    const files = client.files("notes");
    const upload = vi.fn<StashFilesClient["upload"]>();
    upload.mockImplementation((_path, _source, options) => {
      return new Promise<Awaited<ReturnType<StashFilesClient["upload"]>>>((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The upload was aborted.", "AbortError")),
          { once: true },
        );
      });
    });
    vi.spyOn(client, "files").mockImplementation(() => ({ ...files, upload }));
    render(
      <StashUiProvider client={client}>
        <BinaryUploadForm onUploaded={vi.fn()} stash="notes" />
      </StashUiProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText(/Maximum file: 256 B/u);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    await user.upload(
      input,
      new File([new Uint8Array([1, 2, 3])], "sample.bin", {
        type: "application/octet-stream",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByRole("button", { name: "Cancel upload" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel (keep durable parts)" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel upload" }));
  });

  it("uses conservative defaults while exposing server capabilities and JSON mode", async () => {
    expect(defaultUploadRepresentation({ name: "photo.png", type: "image/png" })).toBe("binary");
    expect(defaultUploadRepresentation({ name: "notes.md", type: "" })).toBe("text");
    expect(defaultUploadRepresentation({ name: "unknown", type: "application/octet-stream" })).toBe(
      "binary",
    );

    const user = userEvent.setup();
    renderUploadForm();
    expect(await screen.findByText(/Maximum file: 256 B/u)).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    await user.upload(input, new File(["hello"], "notes.md", { type: "text/markdown" }));
    expect(screen.getByText(/legacy JSON request/u)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Text \(UTF-8\)/u })).toBeTruthy();
  });

  it("commits a multipart upload using the server part size and reports durable completion", async () => {
    const onUploaded = vi.fn();
    const { fake } = renderUploadForm(
      { singleUploadMaxBytes: 2, multipartPartBytes: 2 },
      onUploaded,
    );
    const user = userEvent.setup();
    expect(await screen.findByText(/Multipart parts: 2 B each/u)).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Missing file input");
    await user.upload(
      input,
      new File([new Uint8Array([1, 2, 3, 4, 5])], "sample.bin", {
        type: "application/octet-stream",
      }),
    );
    expect(screen.getByText(/resumable multipart transfer/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(onUploaded.mock.calls[0]?.[0]).toMatchObject({ path: "sample.bin", version: 1 });
    const history = await fake.fetch(
      new Request("https://fake.invalid/v1/stashes/notes/files/sample.bin", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(history.status).toBe(200);
  });
});
