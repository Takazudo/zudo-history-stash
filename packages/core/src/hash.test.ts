import { expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

it.each([
  ["", "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["日本語", "sha256-77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5"],
])("hashes UTF-8 text %j", async (input, expected) =>
  expect(await sha256Hex(input)).toBe(expected),
);

it("hashes raw ArrayBuffer bytes", async () => {
  const bytes = new Uint8Array([0x61, 0x62, 0x63]).buffer;

  await expect(sha256Hex(bytes)).resolves.toBe(
    "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

it("hashes only the addressed bytes of an offset view", async () => {
  const backing = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
  const view = new DataView(backing.buffer, 1, 3);

  await expect(sha256Hex(view)).resolves.toBe(
    "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
