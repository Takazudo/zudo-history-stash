import { describe, expect, it } from "vitest";
import { decodeCanonicalBase64, isCanonicalBase64 } from "./binary.js";

describe("canonical base64", () => {
  it.each([
    ["", []],
    ["AA==", [0]],
    ["AAEC/w==", [0, 1, 2, 255]],
  ])("decodes %j without Node runtime APIs", (value, expected) => {
    expect([...decodeCanonicalBase64(value)]).toEqual(expected);
    expect(isCanonicalBase64(value)).toBe(true);
  });

  it.each(["A", "AAA", "AB==", "AA=", "AA===", "AA==\n", "_A==", " /8="])(
    "rejects non-canonical input %j",
    (value) => {
      expect(() => decodeCanonicalBase64(value)).toThrow(TypeError);
      expect(isCanonicalBase64(value)).toBe(false);
    },
  );
});
