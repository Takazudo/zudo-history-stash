import { describe, expect, it } from "vitest";
import { sha256Hex } from "@takazudo/zudo-history-stash-core";
import { IncrementalSha256 } from "../src/incremental-sha256.js";

describe("IncrementalSha256", () => {
  it("matches WebCrypto across arbitrary block boundaries", async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(4_097));
    const expected = await sha256Hex(bytes);
    for (const sizes of [[4_097], [1, 63, 64, 65, 3_904], Array(4_097).fill(1)]) {
      const hash = new IncrementalSha256();
      let offset = 0;
      for (const size of sizes) {
        hash.update(bytes.subarray(offset, offset + size));
        offset += size;
      }
      expect(offset).toBe(bytes.byteLength);
      expect(hash.digest()).toBe(expected);
    }
  });

  it("handles the empty SHA-256 vector", async () => {
    expect(new IncrementalSha256().digest()).toBe(await sha256Hex(new Uint8Array()));
  });
});
