import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readOptions, runSeed } from "./seed-dev.mjs";

const ADMIN_TOKEN = "admin-fixture";
const WRITE_TOKEN = "zhs_write_token_that_must_not_appear_in_ci_logs";
const BASE_URL = "https://preview.example.test/api";

function successfulFixture({ existing = false } = {}) {
  const transcript = [];
  const record = (operation, payload) => transcript.push({ operation, payload });
  const admin = {
    stashes: {
      async get(stash) {
        record("stashes.get", stash);
        return existing
          ? { ok: true, value: { name: stash } }
          : { ok: false, error: { code: "not-found", message: "missing" } };
      },
      async create(input) {
        record("stashes.create", input);
        return { ok: true, value: { name: input.name } };
      },
      tokens(stash) {
        record("stashes.tokens", stash);
        return {
          async create(input) {
            record("tokens.create", input);
            return {
              ok: true,
              value: { id: "tok_write", scope: "write", token: WRITE_TOKEN },
            };
          },
        };
      },
    },
  };
  const writer = {
    files(stash) {
      record("files", stash);
      return {
        async put(path, input) {
          record("files.put", { input, path });
          return { ok: true, value: { version: input.expectedVersion === null ? 1 : 2 } };
        },
        async delete(path, input) {
          record("files.delete", { input, path });
          return { ok: true, value: { version: 2 } };
        },
        async rollback(path, input) {
          record("files.rollback", { input, path });
          return { ok: true, value: { version: 4 } };
        },
      };
    },
  };
  const createClient = (options) => {
    record("createClient", options);
    if (options.token === ADMIN_TOKEN) return admin;
    if (options.token === WRITE_TOKEN) return writer;
    throw new Error(`Unexpected client token: ${String(options.token)}`);
  };
  return { createClient, transcript };
}

async function exercise(argv, fixture = successfulFixture()) {
  const logs = [];
  await runSeed({
    argv: ["--base-url", `${BASE_URL}/`, ...argv],
    createClient: fixture.createClient,
    env: { STASH_ADMIN_TOKEN: ADMIN_TOKEN },
    log: (line) => logs.push(line),
  });
  return { fixture, logs };
}

describe("seed-dev --ci", () => {
  it("preserves the exact successful API transcript and suppresses only the write token", async () => {
    const normal = await exercise([]);
    const ci = await exercise(["--ci"]);

    assert.deepEqual(ci.fixture.transcript, normal.fixture.transcript);
    assert.equal(normal.logs.filter((line) => line.includes(WRITE_TOKEN)).length, 1);
    assert.equal(
      ci.logs.some((line) => line.includes(WRITE_TOKEN)),
      false,
    );
    assert.deepEqual(
      ci.logs,
      normal.logs.filter((line) => !line.startsWith("Write token")),
    );
    assert.match(ci.logs.join("\n"), /Seeded stash "demo" through/u);
  });

  it("retains the existing-stash skip semantics without minting a token", async () => {
    const normal = await exercise([], successfulFixture({ existing: true }));
    const ci = await exercise(["--ci"], successfulFixture({ existing: true }));

    assert.deepEqual(ci.fixture.transcript, normal.fixture.transcript);
    assert.deepEqual(ci.logs, normal.logs);
    assert.deepEqual(
      ci.fixture.transcript.map(({ operation }) => operation),
      ["createClient", "stashes.get"],
    );
  });

  it("retains failure behavior and never emits a token", async () => {
    const calls = [];
    const createClient = () => ({
      stashes: {
        async get(stash) {
          calls.push(stash);
          return { ok: false, error: { code: "internal", message: "fixture failure" } };
        },
      },
    });
    for (const argv of [[], ["--ci"]]) {
      const logs = [];
      await assert.rejects(
        runSeed({
          argv: ["--base-url", BASE_URL, ...argv],
          createClient,
          env: { STASH_ADMIN_TOKEN: ADMIN_TOKEN },
          log: (line) => logs.push(line),
        }),
        /Checking stash "demo" failed \(internal\): fixture failure/u,
      );
      assert.equal(
        logs.some((line) => line.includes(WRITE_TOKEN)),
        false,
      );
    }
    assert.deepEqual(calls, ["demo", "demo"]);
  });

  it("parses --ci without changing other options and keeps help side-effect free", () => {
    assert.deepEqual(readOptions(["--ci", "--large"], { API_BASE_URL: BASE_URL }), {
      baseUrl: BASE_URL,
      ci: true,
      help: false,
      large: true,
      reset: false,
    });
    assert.equal(readOptions(["--help"], {}).help, true);
    assert.equal(readOptions(["--help", "--unknown"], { API_BASE_URL: "not a URL" }).help, true);
  });
});
