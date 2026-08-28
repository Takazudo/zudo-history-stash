import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PREVIEW_STASH_NAME,
  PREVIEW_TOKEN_LABEL,
  mintPreviewReadToken,
} from "./preview-mint-read-token.mjs";

const TOKEN = "zhs_preview_read_secret";
const TOKEN_ID = "tok_preview";

function fixture(result) {
  const calls = [];
  const createClient = (options) => {
    calls.push({ operation: "client", value: options });
    return {
      stashes: {
        tokens(stash) {
          calls.push({ operation: "tokens", value: stash });
          return {
            async create(input) {
              calls.push({ operation: "create", value: input });
              return result;
            },
          };
        },
      },
    };
  };
  return { calls, createClient };
}

describe("preview read-token mint", () => {
  it("uses the client read scope and masks the token before writing the same-job output", async () => {
    const client = fixture({
      ok: true,
      value: { id: TOKEN_ID, label: PREVIEW_TOKEN_LABEL, scope: "read", token: TOKEN },
    });
    const events = [];
    const result = await mintPreviewReadToken({
      adminToken: "admin-token",
      baseUrl: "https://viewer.example.test/api/",
      outputPath: "/runner/output",
      createClient: client.createClient,
      appendOutput: async (path, value) => events.push({ kind: "output", path, value }),
      writeStdout: (value) => events.push({ kind: "stdout", value }),
    });

    assert.deepEqual(result, { id: TOKEN_ID });
    assert.deepEqual(client.calls, [
      {
        operation: "client",
        value: { baseUrl: "https://viewer.example.test/api", token: "admin-token" },
      },
      { operation: "tokens", value: PREVIEW_STASH_NAME },
      {
        operation: "create",
        value: { label: PREVIEW_TOKEN_LABEL, scope: "read" },
      },
    ]);
    assert.deepEqual(events, [
      { kind: "stdout", value: `::add-mask::${TOKEN}\n` },
      {
        kind: "output",
        path: "/runner/output",
        value: `token=${TOKEN}\ntoken_id=${TOKEN_ID}\n`,
      },
      { kind: "stdout", value: `Minted read-only preview token ${TOKEN_ID}.\n` },
    ]);
  });

  for (const [name, result] of [
    ["API failure", { ok: false, error: { code: "denied", message: "No" } }],
    [
      "wrong scope",
      {
        ok: true,
        value: { id: TOKEN_ID, label: PREVIEW_TOKEN_LABEL, scope: "write", token: TOKEN },
      },
    ],
    [
      "wrong label",
      {
        ok: true,
        value: { id: TOKEN_ID, label: "Other", scope: "read", token: TOKEN },
      },
    ],
    [
      "missing id",
      { ok: true, value: { label: PREVIEW_TOKEN_LABEL, scope: "read", token: TOKEN } },
    ],
    [
      "unsafe token",
      {
        ok: true,
        value: {
          id: TOKEN_ID,
          label: PREVIEW_TOKEN_LABEL,
          scope: "read",
          token: "bad\nvalue",
        },
      },
    ],
  ]) {
    it(`rejects ${name} before masking or producing output`, async () => {
      const client = fixture(result);
      const events = [];
      await assert.rejects(
        mintPreviewReadToken({
          adminToken: "admin-token",
          baseUrl: "https://viewer.example.test/api",
          outputPath: "/runner/output",
          createClient: client.createClient,
          appendOutput: async (...args) => events.push(["output", ...args]),
          writeStdout: (...args) => events.push(["stdout", ...args]),
        }),
        /failed|invalid result/u,
      );
      assert.deepEqual(events, []);
    });
  }
});
