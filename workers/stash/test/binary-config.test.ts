import { MAX_FILE_BYTES_CEILING, MAX_MULTIPART_PARTS } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import { capabilitiesFor, parseBinarySettings } from "../src/binary-config.js";
import { app } from "../src/app.js";
import { request } from "./helpers/app.js";
import { createTestEnv } from "./helpers/env.js";

describe("binary object settings", () => {
  it("publishes the pinned defaults without conflating access and storage", () => {
    const settings = parseBinarySettings(createTestEnv().env);
    expect(settings).toEqual({
      jsonInlineMaxBytes: 5_000_000,
      d1InlineMaxBytes: 524_288,
      httpRequestMaxBytes: 100_000_000,
      singleUploadMaxBytes: 33_554_432,
      maxFileBytes: 100_000_000,
      diffMaxBytes: 524_288,
      multipartPartBytes: 8_388_608,
      maxOpenUploadSessions: 8,
      maxReservedUploadBytes: 500_000_000,
      uploadSessionTtlSeconds: 86_400,
    });
    expect(capabilitiesFor(settings)).toMatchObject({
      representations: ["text", "binary"],
      contentAccess: ["inline", "raw", "deleted"],
      transferModes: ["json", "single", "multipart"],
      storageTiers: ["d1", "r2"],
      limits: { maxMultipartParts: MAX_MULTIPART_PARTS },
    });
  });

  it("serves capabilities without authentication", async () => {
    const response = await request(
      app,
      "http://stash.test/v1/capabilities",
      {},
      createTestEnv().env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      representations: ["text", "binary"],
      limits: { maxFileBytes: 100_000_000, multipartPartBytes: 8_388_608 },
    });
  });

  it.each([
    ["D1 ceiling", { d1InlineMaxBytes: 1_500_001 }],
    [
      "file ceiling",
      {
        maxFileBytes: MAX_FILE_BYTES_CEILING + 1,
        maxReservedUploadBytes: MAX_FILE_BYTES_CEILING + 1,
      },
    ],
    ["JSON versus file", { jsonInlineMaxBytes: 101, maxFileBytes: 100 }],
    ["JSON versus request", { jsonInlineMaxBytes: 101, httpRequestMaxBytes: 100 }],
    ["D1 versus file", { d1InlineMaxBytes: 101, maxFileBytes: 100 }],
    ["single versus request", { singleUploadMaxBytes: 101, httpRequestMaxBytes: 100 }],
    ["single versus file", { singleUploadMaxBytes: 101, maxFileBytes: 100 }],
    ["part versus request", { multipartPartBytes: 101, httpRequestMaxBytes: 100 }],
    ["reservation", { maxReservedUploadBytes: 99, maxFileBytes: 100 }],
    ["part count", { multipartPartBytes: 1, maxFileBytes: 10_001 }],
    ["TTL", { uploadSessionTtlSeconds: 31_536_001 }],
    ["session count", { maxOpenUploadSessions: 10_001 }],
  ])("rejects the %s invariant", (_name, overrides) => {
    expect(() => parseBinarySettings(createTestEnv().env, overrides)).toThrow();
  });

  it("accepts injected small parts for tests and the 1 GiB correctness ceiling", () => {
    const settings = parseBinarySettings(createTestEnv().env, {
      maxFileBytes: MAX_FILE_BYTES_CEILING,
      maxReservedUploadBytes: MAX_FILE_BYTES_CEILING,
      multipartPartBytes: 128 * 1_024,
      singleUploadMaxBytes: 32 * 1_024 * 1_024,
    });
    expect(Math.ceil(settings.maxFileBytes / settings.multipartPartBytes)).toBeLessThanOrEqual(
      MAX_MULTIPART_PARTS,
    );
  });

  it("rejects malformed environment integers", () => {
    const bindings = createTestEnv({ env: { MAX_FILE_BYTES: "1.5" } }).env;
    expect(() => parseBinarySettings(bindings)).toThrow("MAX_FILE_BYTES");
  });

  it("uses pinned defaults when an environment value is empty", () => {
    const bindings = createTestEnv({ env: { MAX_FILE_BYTES: "" } }).env;
    expect(parseBinarySettings(bindings).maxFileBytes).toBe(100_000_000);
  });

  it("does not allow production env to bypass the R2 minimum part size", () => {
    const bindings = createTestEnv({ env: { MULTIPART_PART_BYTES: "5242879" } }).env;
    expect(() => parseBinarySettings(bindings)).toThrow("at least");
  });
});
