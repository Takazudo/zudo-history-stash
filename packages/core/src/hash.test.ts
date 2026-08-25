import { expect, it } from "vitest";
import { sha256Hex } from "./hash.js";

it.each([
  ["", "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["日本語", "sha256-77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5"],
])("hashes UTF-8 text %j", async (input, expected) =>
  expect(await sha256Hex(input)).toBe(expected),
);
