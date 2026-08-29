import { describe, expect, it, vi } from "vitest";
import type { CapabilitiesResponse } from "@takazudo/zudo-history-stash-core";
import { createStashClient } from "./client.js";
import { selectUploadMode } from "./binary.js";
import { createFakeStash } from "./testing/fake.js";

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
      jsonInlineMaxBytes: 3,
      d1InlineMaxBytes: 8,
      httpRequestMaxBytes: 16,
      singleUploadMaxBytes: 8,
      maxFileBytes: 1_073_741_824,
      diffMaxBytesPerSide: 8,
      multipartPartBytes: 2,
      maxMultipartParts: 10_000,
      maxOpenUploadSessionsPerStash: 32,
      maxReservedUploadBytesPerStash: 2_147_483_648,
      uploadSessionTtlSeconds: 60,
      ...overrides,
    },
  };
}

function fixture(overrides: Partial<CapabilitiesResponse["limits"]> = {}) {
  const fake = createFakeStash({ adminToken: "admin", capabilities: capabilities(overrides) });
  fake.createStash("demo");
  const client = createStashClient({
    baseUrl: "https://fake.invalid",
    token: "admin",
    fetch: fake.fetch,
    idempotencyKey: () => crypto.randomUUID(),
  });
  return { fake, client };
}

describe("binary SDK", () => {
  it("round-trips arbitrary bytes and historical ranges without UTF-8 coercion", async () => {
    const { client } = fixture();
    const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x0d, 0x0a]);
    const uploaded = await client.files("demo").upload("images/sample.bin", bytes, {
      expectedVersion: null,
      representation: "binary",
      contentType: "application/octet-stream",
    });
    expect(uploaded.ok).toBe(true);

    const downloaded = await client.files("demo").raw.get("images/sample.bin", {
      range: "bytes=1-3",
    });
    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok || "notModified" in downloaded) return;
    expect([...(await downloaded.value.bytes(3))]).toEqual([0x50, 0x00, 0xff]);

    const metadata = await client.files("demo").get("images/sample.bin");
    expect(metadata).toMatchObject({
      ok: true,
      value: { representation: "binary", contentAccess: "raw", body: null, byteSize: 6 },
    });

    await expect(
      client.files("demo").delete("images/sample.bin", { expectedVersion: 1 }),
    ).resolves.toMatchObject({ ok: true, value: { version: 2 } });
    await expect(client.files("demo").raw.get("images/sample.bin")).resolves.toMatchObject({
      ok: false,
      error: { code: "file-deleted" },
    });
    const historical = await client.files("demo").raw.get("images/sample.bin", { version: 1 });
    expect(historical.ok).toBe(true);
    if (historical.ok && !("notModified" in historical)) {
      await expect(historical.value.bytes(6)).resolves.toEqual(bytes);
    }
    await expect(
      client.files("demo").rollback("images/sample.bin", {
        expectedVersion: 2,
        toVersion: 1,
      }),
    ).resolves.toMatchObject({ ok: true, value: { representation: "binary", rollbackOf: 1 } });
    await expect(client.files("demo").get("images/sample.bin")).resolves.toMatchObject({
      ok: true,
      value: { representation: "binary", contentAccess: "raw", body: null },
    });
  });

  it("keeps oversized valid UTF-8 text as text while selecting raw transfer", async () => {
    const { client } = fixture({ jsonInlineMaxBytes: 3, singleUploadMaxBytes: 16 });
    await expect(
      client.files("demo").upload("docs/small.txt", "hi", {
        expectedVersion: null,
        representation: "text",
        contentType: "text/plain; charset=utf-8",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { representation: "text", contentType: "text/plain; charset=utf-8", size: 2 },
    });
    await expect(
      client.files("demo").upload("docs/large.txt", "hello", {
        expectedVersion: null,
        representation: "text",
        contentType: "text/plain; charset=utf-8",
      }),
    ).resolves.toMatchObject({ ok: true, value: { representation: "text" } });
    await expect(client.files("demo").get("docs/large.txt")).resolves.toMatchObject({
      ok: true,
      value: { representation: "text", contentAccess: "raw", body: null },
    });
  });

  it("uploads only durable multipart parts and reports observed progress", async () => {
    const { client } = fixture({ singleUploadMaxBytes: 2, multipartPartBytes: 2 });
    const progress = vi.fn();
    const result = await client
      .files("demo")
      .upload("archives/sample.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa]), {
        expectedVersion: null,
        representation: "binary",
        contentType: "application/zip",
        onProgress: progress,
      });
    expect(result.ok).toBe(true);
    expect(
      progress.mock.calls.some(([value]) => value.phase === "part" && value.durableParts === 3),
    ).toBe(true);
    expect(progress).toHaveBeenLastCalledWith({
      observedBytes: 5,
      totalBytes: 5,
      phase: "complete",
    });

    const oneShot = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    await expect(
      client.files("demo").upload("streams/large.bin", oneShot, {
        expectedVersion: null,
        representation: "binary",
        contentType: "application/octet-stream",
        size: 5,
      }),
    ).resolves.toMatchObject({ ok: true, value: { size: 5 } });
  });

  it("retries a replayable source with stable operation keys", async () => {
    const fake = createFakeStash({
      adminToken: "admin",
      capabilities: capabilities({ singleUploadMaxBytes: 16 }),
    });
    fake.createStash("demo");
    let contentRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/content") && contentRequests++ === 0) {
        if (init?.body !== undefined) await new Response(init.body).arrayBuffer();
        return Response.json(
          { error: { code: "internal", message: "simulated" } },
          { status: 500 },
        );
      }
      return fake.fetch(input, init);
    };
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fetcher,
    });
    await expect(
      client.files("demo").upload("replayed.bin", new Blob([new Uint8Array([1, 2, 3])]), {
        expectedVersion: null,
        representation: "binary",
        contentType: "application/octet-stream",
        retries: 1,
      }),
    ).resolves.toMatchObject({ ok: true, value: { size: 3 } });
    expect(contentRequests).toBe(2);
    expect(fake.state.versions).toHaveLength(1);
  });

  it("selects a synthetic 1 GiB source as multipart without allocating it", () => {
    expect(
      selectUploadMode(
        { size: 1_073_741_824, replayable: true, text: false },
        capabilities({ maxFileBytes: 1_073_741_824, singleUploadMaxBytes: 32_000_000 }),
        { representation: "binary" },
      ),
    ).toBe("multipart");
    expect(() =>
      selectUploadMode({ size: 2, replayable: true, text: true }, capabilities(), {
        representation: "text",
        mode: "json",
        resumable: true,
      }),
    ).toThrow("resumable upload must use multipart");
  });

  it("requires exact stream size and never replays a consumed one-shot stream", async () => {
    const fake = createFakeStash({
      adminToken: "admin",
      capabilities: capabilities({ singleUploadMaxBytes: 16 }),
    });
    fake.createStash("demo");
    let contentRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/content")) {
        contentRequests += 1;
        if (init?.body !== undefined) await new Response(init.body).arrayBuffer();
        return Response.json(
          { error: { code: "internal", message: "simulated" } },
          { status: 500 },
        );
      }
      return fake.fetch(input, init);
    };
    const client = createStashClient({
      baseUrl: "https://fake.invalid",
      token: "admin",
      fetch: fetcher,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await expect(
      client.files("demo").upload("missing-size.bin", stream, {
        expectedVersion: null,
        representation: "binary",
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("requires an exact non-negative size");
    await expect(
      client.files("demo").upload("one-shot.bin", stream, {
        expectedVersion: null,
        representation: "binary",
        contentType: "application/octet-stream",
        size: 3,
        retries: 3,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(contentRequests).toBe(1);
  });
});
