import {
  createStashClient,
  type CapabilitiesResponse,
  type FileRecordWithEtag,
  type RawDownload,
  type StashFilesClient,
  type StashClient,
} from "@takazudo/zudo-history-stash";
import { createFakeStash } from "@takazudo/zudo-history-stash/testing";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StashUiProvider } from "../provider/stash-ui-provider.js";
import {
  fileContentAccess,
  fileRepresentation,
  FileContent,
  MAX_BLOB_DOWNLOAD_BYTES,
  saveRawDownload,
} from "./file-content.js";

const token = "file-content-ui-admin";

async function uploadedFile(
  path: string,
  representation: "text" | "binary",
  contentType: string,
  source: string | Uint8Array,
  capabilityOverrides: Partial<CapabilitiesResponse["limits"]> = {},
): Promise<{ client: StashClient; file: FileRecordWithEtag }> {
  const fake = createFakeStash({
    adminToken: token,
    capabilities: {
      representations: ["text", "binary"],
      contentAccess: ["inline", "raw", "deleted"],
      transferModes: ["json", "single", "multipart"],
      storageTiers: ["d1", "r2"],
      limits: {
        jsonInlineMaxBytes: 2,
        d1InlineMaxBytes: 2,
        httpRequestMaxBytes: 100,
        singleUploadMaxBytes: 32,
        maxFileBytes: 256,
        diffMaxBytesPerSide: 16,
        multipartPartBytes: 8,
        maxMultipartParts: 10_000,
        maxOpenUploadSessionsPerStash: 32,
        maxReservedUploadBytesPerStash: 512,
        uploadSessionTtlSeconds: 600,
        ...capabilityOverrides,
      },
    },
  });
  fake.createStash("notes");
  const client = createStashClient({ baseUrl: "https://fake.invalid", token, fetch: fake.fetch });
  const result = await client.files("notes").upload(path, source, {
    expectedVersion: null,
    representation,
    contentType,
    mode: "single",
    resumable: false,
  });
  if (!result.ok) throw new Error(result.error.message);
  const file = await client.files("notes").get(path);
  if (!file.ok || "notModified" in file) throw new Error("Missing uploaded file");
  return { client, file: file.value };
}

function rawDownload(response: Response, size: number): RawDownload {
  return {
    response,
    body: response.body,
    version: 1,
    etag: '"test"',
    contentType: "application/octet-stream",
    size,
    contentRange: null,
    bytes: async () => new Uint8Array(),
    text: async () => "",
  };
}

describe("FileContent", () => {
  it("keeps legacy inline, raw-only, and tombstone states independent", () => {
    const inline = { body: "text", deleted: false, representation: "text" as const };
    const raw = { body: null, deleted: false, representation: "text" as const };
    const binary = { body: null, deleted: false, representation: "binary" as const };
    const tombstone = { body: null, deleted: true, representation: "binary" as const };
    expect(fileRepresentation(inline)).toBe("text");
    expect(fileContentAccess(inline)).toBe("inline");
    expect(fileRepresentation(raw)).toBe("text");
    expect(fileContentAccess(raw)).toBe("raw");
    expect(fileRepresentation(binary)).toBe("binary");
    expect(fileContentAccess(binary)).toBe("raw");
    expect(fileContentAccess(tombstone)).toBe("deleted");
  });

  it("previews only a matching allowlisted raster type and revokes its object URL", async () => {
    const { client, file } = await uploadedFile(
      "images/sample.png",
      "binary",
      "image/png",
      new Uint8Array([137, 80, 78, 71]),
    );
    const createObjectURL = vi.fn(() => "blob:sample");
    const revokeObjectURL = vi.fn();
    const URLConstructor = globalThis.URL;
    class TestURL extends URLConstructor {}
    Object.defineProperties(TestURL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });
    vi.stubGlobal("URL", TestURL);
    const rendered = render(
      <StashUiProvider client={client}>
        <FileContent file={file} path={file.path} stash="notes" />
      </StashUiProvider>,
    );
    expect(await screen.findByRole("img", { name: "Preview of images/sample.png" })).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sample");
  });

  it("renders unsupported binary and oversized raw text as download-only", async () => {
    const binary = await uploadedFile(
      "archives/sample.zip",
      "binary",
      "application/zip",
      new Uint8Array([80, 75, 3, 4]),
    );
    render(
      <StashUiProvider client={binary.client}>
        <FileContent file={binary.file} path={binary.file.path} stash="notes" />
      </StashUiProvider>,
    );
    expect(await screen.findByText("Binary content is download-only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download current raw content" })).toBeTruthy();

    const text = await uploadedFile("docs/large.txt", "text", "text/plain", "hello");
    render(
      <StashUiProvider client={text.client}>
        <FileContent file={text.file} maxTextPreviewBytes={2} path={text.file.path} stash="notes" />
      </StashUiProvider>,
    );
    expect(await screen.findByText("Raw text is too large to preview")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Download current raw content" }).at(-1),
    ).toBeTruthy();
  });

  it("streams large raw downloads to File System Access without calling blob", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const response = new Response(body, {
      headers: {
        "Content-Length": String(MAX_BLOB_DOWNLOAD_BYTES + 1),
        "Content-Type": "application/octet-stream",
      },
    });
    const blob = vi.spyOn(response, "blob");
    const writes: Uint8Array[] = [];
    const writable = Object.assign(
      new WritableStream<Uint8Array>({
        write(chunk) {
          writes.push(chunk);
        },
      }),
      { close: vi.fn(async () => undefined) },
    );
    const picker = vi.fn(async () => ({
      createWritable: vi.fn(async () => writable),
    }));
    vi.stubGlobal("showSaveFilePicker", picker);
    try {
      await expect(
        saveRawDownload(
          rawDownload(response, MAX_BLOB_DOWNLOAD_BYTES + 1),
          "large.bin",
          new AbortController().signal,
        ),
      ).resolves.toBeNull();
      expect(blob).not.toHaveBeenCalled();
      expect(picker).toHaveBeenCalledWith({ suggestedName: "large.bin" });
      expect([...writes[0]!]).toEqual([1, 2, 3]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses oversized raw downloads before any blob materialization without a stream saver", async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "Content-Length": String(MAX_BLOB_DOWNLOAD_BYTES + 1) },
    });
    const blob = vi.spyOn(response, "blob");
    vi.stubGlobal("showSaveFilePicker", undefined);
    try {
      await expect(
        saveRawDownload(
          rawDownload(response, MAX_BLOB_DOWNLOAD_BYTES + 1),
          "large.bin",
          new AbortController().signal,
        ),
      ).rejects.toThrow(/cannot buffer a raw download/u);
      expect(blob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requests the native save destination before fetching raw bytes", async () => {
    const { client, file } = await uploadedFile(
      "archives/order.zip",
      "binary",
      "application/zip",
      new Uint8Array([80, 75, 3, 4]),
    );
    const originalFiles = client.files("notes");
    const order: string[] = [];
    const rawGet = vi.fn<StashFilesClient["raw"]["get"]>().mockImplementation(async () => {
      order.push("fetch");
      const response = new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "Content-Length": "4", "Content-Type": "application/zip" },
      });
      return { ok: true, value: rawDownload(response, 4) };
    });
    vi.spyOn(client, "files").mockImplementation(() => ({
      ...originalFiles,
      raw: { ...originalFiles.raw, get: rawGet },
    }));
    const writable = Object.assign(new WritableStream<Uint8Array>({ write() {} }), {
      close: vi.fn(async () => undefined),
    });
    const picker = vi.fn(async () => {
      order.push("picker");
      return { createWritable: vi.fn(async () => writable) };
    });
    vi.stubGlobal("showSaveFilePicker", picker);
    const rendered = render(
      <StashUiProvider client={client}>
        <FileContent file={file} path={file.path} stash="notes" />
      </StashUiProvider>,
    );
    try {
      expect(await screen.findByText("Binary content is download-only")).toBeTruthy();
      order.length = 0;
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Download current raw content" }));
      await waitFor(() => expect(order).toEqual(["picker", "fetch"]));
      expect(rawGet).toHaveBeenCalledTimes(2);
    } finally {
      rendered.unmount();
      vi.unstubAllGlobals();
    }
  });
});
