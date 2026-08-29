import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  createPreviewReaper,
  parseArguments,
  parsePreviewPr,
  parsePreviewResourceName,
  runCli,
} from "./preview-reaper.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const DEPLOY_WORKFLOW = resolve(REPOSITORY_ROOT, ".github/workflows/preview.yml");
const TEARDOWN_WORKFLOW = resolve(REPOSITORY_ROOT, ".github/workflows/preview-teardown.yml");
const REAPER_WORKFLOW = resolve(REPOSITORY_ROOT, ".github/workflows/preview-reaper.yml");
const CF_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account-fixture",
  CLOUDFLARE_API_TOKEN: "cloudflare-token-fixture",
  GITHUB_REPOSITORY: "Takazudo/zudo-history-stash",
};

function cfSuccess(result, resultInfo) {
  return new Response(
    JSON.stringify({ errors: [], messages: [], result, result_info: resultInfo, success: true }),
    { headers: { "Content-Type": "application/json" }, status: 200 },
  );
}

function cfFailure(status, message) {
  return new Response(
    JSON.stringify({
      errors: [{ code: 10_000, message }],
      messages: [],
      result: null,
      success: false,
    }),
    { headers: { "Content-Type": "application/json" }, status },
  );
}

function workerPage(
  names,
  { page = 1, perPage = 100, totalCount = names.length, totalPages = 1 } = {},
) {
  return cfSuccess(
    names.map((scriptName, index) => ({
      id: `worker-${String(page)}-${String(index)}`,
      script_name: scriptName,
    })),
    {
      count: names.length,
      page,
      per_page: perPage,
      total_count: totalCount,
      total_pages: totalPages,
    },
  );
}

function r2Page(names, cursor) {
  return cfSuccess(
    { buckets: names.map((name) => ({ name })) },
    cursor === undefined ? { per_page: 1_000 } : { cursor, per_page: 1_000 },
  );
}

function requestSuffix(url) {
  const parsed = new URL(url);
  const prefix = "/client/v4/accounts/account-fixture";
  assert.ok(parsed.pathname.startsWith(prefix), `Unexpected Cloudflare URL: ${url}`);
  return `${parsed.pathname.slice(prefix.length)}${parsed.search}`;
}

function fetchFixture(expected) {
  const remaining = [...expected];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const next = remaining.shift();
    assert.ok(next, `Unexpected Cloudflare call: ${String(url)}`);
    const suffix = requestSuffix(String(url));
    calls.push({ init, suffix });
    assert.equal(init.headers.Authorization, `Bearer ${CF_ENV.CLOUDFLARE_API_TOKEN}`);
    if (next.path instanceof RegExp) assert.match(suffix, next.path);
    else assert.equal(suffix, next.path);
    assert.equal(init.method, next.method ?? "GET");
    if (next.error) throw next.error;
    return next.response;
  };
  return {
    assertDone() {
      assert.deepEqual(remaining, []);
    },
    calls,
    fetchImpl,
  };
}

function wranglerFixture(expected) {
  const remaining = [...expected];
  const calls = [];
  const runWrangler = async (args) => {
    const next = remaining.shift();
    assert.ok(next, `Unexpected Wrangler call: ${args.join(" ")}`);
    calls.push(args);
    assert.deepEqual(args, next.args);
    if (next.error) throw next.error;
    return next.result ?? "";
  };
  return {
    assertDone() {
      assert.deepEqual(remaining, []);
    },
    calls,
    runWrangler,
  };
}

function ghFixture(expected) {
  const remaining = [...expected];
  const calls = [];
  const runGh = async (args) => {
    const next = remaining.shift();
    assert.ok(next, `Unexpected gh call: ${args.join(" ")}`);
    calls.push(args);
    if (next.error) throw next.error;
    return next.result;
  };
  return {
    assertDone() {
      assert.deepEqual(remaining, []);
    },
    calls,
    runGh,
  };
}

function pullJson(pr, { fork = false, state = "closed" } = {}) {
  return JSON.stringify({ head: { repo: { fork } }, number: pr, state });
}

describe("preview PR and resource-name parsing", () => {
  it("accepts only canonical positive safe-integer PR strings", () => {
    assert.equal(parsePreviewPr("1"), 1);
    assert.equal(parsePreviewPr("12"), 12);
    assert.equal(parsePreviewPr(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);

    for (const value of [
      undefined,
      null,
      12,
      "",
      " 12",
      "12 ",
      "0",
      "-1",
      "+1",
      "1.0",
      "1e2",
      "01",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      assert.throws(() => parsePreviewPr(value), /canonical|safe positive/u, String(value));
    }
  });

  it("recognizes every exact type-specific preview name and ignores fuzzy neighbors", () => {
    assert.equal(parsePreviewResourceName("worker", "zudo-history-stash-pr-2"), 2);
    assert.equal(parsePreviewResourceName("worker", "zudo-history-stash-viewer-pr-10"), 10);
    assert.equal(parsePreviewResourceName("d1", "zudo-history-stash-pr-3"), 3);
    assert.equal(parsePreviewResourceName("r2", "zudo-history-stash-blobs-pr-4"), 4);

    for (const [kind, name] of [
      ["worker", "zudo-history-stash-preview"],
      ["worker", "prefix-zudo-history-stash-pr-2"],
      ["worker", "zudo-history-stash-pr-2-suffix"],
      ["worker", "zudo-history-stash-pr-02"],
      ["worker", "zudo-history-stash-blobs-pr-2"],
      ["d1", "zudo-history-stash-viewer-pr-2"],
      ["r2", "zudo-history-stash-pr-2"],
      ["r2", "zudo-history-stash-blobs-pr-０"],
    ]) {
      assert.equal(parsePreviewResourceName(kind, name), null, `${kind}: ${name}`);
    }
    assert.throws(
      () =>
        parsePreviewResourceName(
          "worker",
          `zudo-history-stash-pr-${String(Number.MAX_SAFE_INTEGER + 1)}`,
        ),
      /safe positive/u,
    );
  });

  it("rejects malformed CLI shapes before constructing an external client", async () => {
    for (const argv of [
      [],
      ["unknown"],
      ["discover", "--pr", "1"],
      ["check-pr"],
      ["teardown", "--pr", "01"],
      ["teardown", "--pr", "1", "--pr", "2"],
    ]) {
      assert.throws(() => parseArguments(argv));
    }

    let created = 0;
    const lines = [];
    await runCli(["--help"], {
      createReaper() {
        created += 1;
        throw new Error("must not construct");
      },
      writeLine: (line) => lines.push(line),
    });
    assert.equal(created, 0);
    assert.match(lines[0], /discover\|check-pr\|teardown/u);
  });
});

describe("complete preview inventory", () => {
  it("unions and sorts Worker, long D1, and cursor-paginated R2 candidates", async () => {
    const fetches = fetchFixture([
      {
        path: "/workers/scripts-search?page=1&per_page=100",
        response: workerPage(
          [
            "zudo-history-stash-pr-10",
            "zudo-history-stash-viewer-pr-2",
            "zudo-history-stash-pr-02",
          ],
          { page: 1, perPage: 3, totalCount: 5, totalPages: 2 },
        ),
      },
      {
        path: "/workers/scripts-search?page=2&per_page=100",
        response: workerPage(["zudo-history-stash-viewer-pr-10", "zudo-history-stash-pr-3"], {
          page: 2,
          perPage: 3,
          totalCount: 5,
          totalPages: 2,
        }),
      },
      {
        path: "/r2/buckets?per_page=1000",
        response: r2Page(["other", "zudo-history-stash-blobs-pr-9"], "next page"),
      },
      {
        path: "/r2/buckets?per_page=1000&cursor=next+page",
        response: r2Page(["zudo-history-stash-blobs-pr-4", "zudo-history-stash-pr-88"]),
      },
    ]);
    const databases = Array.from({ length: 14 }, (_, index) => ({
      name: `ordinary-${String(index)}`,
    }));
    databases.push({ name: "zudo-history-stash-pr-7" }, { name: "zudo-history-stash-pr-03" });
    const wrangler = wranglerFixture([
      { args: ["d1", "list", "--json"], result: JSON.stringify(databases) },
    ]);
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: wrangler.runWrangler,
    });

    assert.deepEqual(await reaper.discover(), [2, 3, 4, 7, 9, 10]);
    fetches.assertDone();
    wrangler.assertDone();
  });

  it("rejects malformed or incomplete pagination instead of truncating", async () => {
    for (const [name, expected, pattern] of [
      [
        "worker total-pages drift",
        [
          {
            path: "/workers/scripts-search?page=1&per_page=100",
            response: workerPage(["zudo-history-stash-pr-1"], { page: 1, totalPages: 2 }),
          },
          {
            path: "/workers/scripts-search?page=2&per_page=100",
            response: workerPage([], { page: 2, totalPages: 3 }),
          },
        ],
        /total_pages changed/u,
      ],
      [
        "worker malformed row",
        [
          {
            path: "/workers/scripts-search?page=1&per_page=100",
            response: cfSuccess([{ service_name: "wrong-field" }], {
              count: 1,
              page: 1,
              per_page: 100,
              total_count: 1,
              total_pages: 1,
            }),
          },
        ],
        /invalid worker entry/u,
      ],
      [
        "worker total-count drift",
        [
          {
            path: "/workers/scripts-search?page=1&per_page=100",
            response: workerPage(["zudo-history-stash-pr-1"], {
              page: 1,
              totalCount: 2,
              totalPages: 2,
            }),
          },
          {
            path: "/workers/scripts-search?page=2&per_page=100",
            response: workerPage(["zudo-history-stash-pr-2"], {
              page: 2,
              totalCount: 3,
              totalPages: 2,
            }),
          },
        ],
        /total_count changed/u,
      ],
      [
        "worker total-count truncation",
        [
          {
            path: "/workers/scripts-search?page=1&per_page=100",
            response: workerPage([], { totalCount: 1, totalPages: 0 }),
          },
        ],
        /total_count did not match/u,
      ],
      [
        "worker missing total-count",
        [
          {
            path: "/workers/scripts-search?page=1&per_page=100",
            response: cfSuccess([], {
              count: 0,
              page: 1,
              per_page: 100,
              total_pages: 0,
            }),
          },
        ],
        /omitted total_count/u,
      ],
    ]) {
      const fetches = fetchFixture(expected);
      const reaper = createPreviewReaper({
        env: CF_ENV,
        fetchImpl: fetches.fetchImpl,
        runWrangler: async () => "[]",
      });
      await assert.rejects(reaper.discover(), pattern, name);
      fetches.assertDone();
    }

    const repeatedCursor = fetchFixture([
      { path: "/workers/scripts-search?page=1&per_page=100", response: workerPage([]) },
      { path: "/r2/buckets?per_page=1000", response: r2Page([], "same") },
      { path: "/r2/buckets?per_page=1000&cursor=same", response: r2Page([], "same") },
    ]);
    const repeated = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: repeatedCursor.fetchImpl,
      runWrangler: async () => "[]",
    });
    await assert.rejects(repeated.discover(), /repeated cursor/u);
    repeatedCursor.assertDone();

    for (const [name, response, pattern] of [
      ["missing buckets", cfSuccess({}, { per_page: 1_000 }), /invalid buckets/u],
      ["missing result info", cfSuccess({ buckets: [] }, undefined), /invalid result_info/u],
      ["null result info", cfSuccess({ buckets: [] }, null), /invalid result_info/u],
      ["array result info", cfSuccess({ buckets: [] }, []), /invalid result_info/u],
      [
        "non-string cursor",
        cfSuccess({ buckets: [] }, { cursor: 42, per_page: 1_000 }),
        /non-string cursor/u,
      ],
    ]) {
      const fetches = fetchFixture([
        { path: "/workers/scripts-search?page=1&per_page=100", response: workerPage([]) },
        { path: "/r2/buckets?per_page=1000", response },
      ]);
      const reaper = createPreviewReaper({
        env: CF_ENV,
        fetchImpl: fetches.fetchImpl,
        runWrangler: async () => "[]",
      });
      await assert.rejects(reaper.discover(), pattern, name);
      fetches.assertDone();
    }

    const badD1Fetch = fetchFixture([
      { path: "/workers/scripts-search?page=1&per_page=100", response: workerPage([]) },
    ]);
    const badD1 = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: badD1Fetch.fetchImpl,
      runWrangler: async () => "not json",
    });
    await assert.rejects(badD1.discover(), /invalid JSON/u);
    badD1Fetch.assertDone();
  });

  it("fails closed before emitting a matrix larger than GitHub supports", async () => {
    const fetches = fetchFixture([
      { path: "/workers/scripts-search?page=1&per_page=100", response: workerPage([]) },
      { path: "/r2/buckets?per_page=1000", response: r2Page([]) },
    ]);
    const databases = Array.from({ length: 257 }, (_, index) => ({
      name: `zudo-history-stash-pr-${String(index + 1)}`,
    }));
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: async () => JSON.stringify(databases),
    });
    await assert.rejects(reaper.discover(), /more than 256 candidates/u);
    fetches.assertDone();
  });

  it("does not compare filtered Worker rows with the unfiltered total_count", async () => {
    const name = "zudo-history-stash-pr-18";
    const fetches = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([], { totalCount: 47, totalPages: 0 }),
      },
    ]);
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: async () => assert.fail("Wrangler must not run"),
    });
    assert.equal(await reaper.deleteWorkerVerified(name), "absent");
    fetches.assertDone();
  });
});

describe("verified Worker deletion", () => {
  it("skips Wrangler for structured exact absence despite fuzzy search neighbors", async () => {
    const name = "zudo-history-stash-viewer-pr-12";
    const fetches = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([`${name}-neighbor`]),
      },
    ]);
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: async (args) => assert.fail(`Unexpected Wrangler call: ${args.join(" ")}`),
    });
    assert.equal(await reaper.deleteWorkerVerified(name), "absent");
    fetches.assertDone();
  });

  it("uses exact --force argv and verifies absence after a successful deletion", async () => {
    const name = "zudo-history-stash-pr-12";
    const fetches = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([name]),
      },
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([]),
      },
    ]);
    const wrangler = wranglerFixture([
      { args: ["delete", "--name", name, "--force"], result: "human success" },
    ]);
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: wrangler.runWrangler,
    });
    assert.equal(await reaper.deleteWorkerVerified(name), "deleted");
    fetches.assertDone();
    wrangler.assertDone();
  });

  it("tolerates command failure only when the structured postcheck proves absence", async () => {
    const name = "zudo-history-stash-pr-13";
    const fetches = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([name]),
      },
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([]),
      },
    ]);
    const wrangler = wranglerFixture([
      { args: ["delete", "--name", name, "--force"], error: new Error("race") },
    ]);
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: wrangler.runWrangler,
    });
    assert.equal(await reaper.deleteWorkerVerified(name), "absent");
    fetches.assertDone();
    wrangler.assertDone();
  });

  for (const commandFails of [false, true]) {
    it(`fails when the Worker remains after ${commandFails ? "failed" : "successful"} Wrangler`, async () => {
      const name = "zudo-history-stash-pr-14";
      const fetches = fetchFixture([
        {
          path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
          response: workerPage([name]),
        },
        {
          path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
          response: workerPage([name]),
        },
      ]);
      const wrangler = wranglerFixture([
        {
          args: ["delete", "--name", name, "--force"],
          ...(commandFails ? { error: new Error("delete failed") } : { result: "success" }),
        },
      ]);
      const reaper = createPreviewReaper({
        env: CF_ENV,
        fetchImpl: fetches.fetchImpl,
        runWrangler: wrangler.runWrangler,
      });
      await assert.rejects(reaper.deleteWorkerVerified(name), /still exists/u);
      fetches.assertDone();
      wrangler.assertDone();
    });
  }

  it("rejects duplicate exact rows and HTTP errors without invoking Wrangler", async () => {
    const name = "zudo-history-stash-pr-15";
    const duplicates = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: workerPage([name, name]),
      },
    ]);
    const duplicateReaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: duplicates.fetchImpl,
      runWrangler: async () => assert.fail("Wrangler must not run"),
    });
    await assert.rejects(duplicateReaper.deleteWorkerVerified(name), /multiple Workers/u);
    duplicates.assertDone();

    const forbidden = fetchFixture([
      {
        path: `/workers/scripts-search?name=${name}&page=1&per_page=100`,
        response: cfFailure(403, "not found (hostile prose)"),
      },
    ]);
    const forbiddenReaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: forbidden.fetchImpl,
      runWrangler: async () => assert.fail("Wrangler must not run"),
    });
    await assert.rejects(forbiddenReaper.deleteWorkerVerified(name), /failed \(403\)/u);
    forbidden.assertDone();
  });
});

describe("pull state and ordered idempotent teardown", () => {
  it("validates exact PR identity, state, and fork from gh argv-array output", async () => {
    const gh = ghFixture([{ result: pullJson(22, { fork: true, state: "closed" }) }]);
    const reaper = createPreviewReaper({ env: CF_ENV, runGh: gh.runGh, resources: {} });
    assert.deepEqual(await reaper.readPull(22), { fork: true, pr: 22, state: "closed" });
    assert.deepEqual(gh.calls[0], [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "repos/Takazudo/zudo-history-stash/pulls/22",
    ]);
    gh.assertDone();
  });

  it("fails closed on open/missing/malformed/mismatched PR evidence without Cloudflare calls", async () => {
    for (const [name, response, pattern] of [
      ["mismatch", pullJson(24), /mismatched/u],
      [
        "invalid state",
        JSON.stringify({ head: { repo: { fork: false } }, number: 23, state: "merged" }),
        /invalid pull request state/u,
      ],
      [
        "missing fork",
        JSON.stringify({ head: { repo: null }, number: 23, state: "closed" }),
        /fork state/u,
      ],
      ["malformed", "not json", /malformed/u],
    ]) {
      const gh = ghFixture([{ result: response }]);
      const reaper = createPreviewReaper({
        env: CF_ENV,
        fetchImpl: async () => assert.fail("Cloudflare must not run"),
        runGh: gh.runGh,
        runWrangler: async () => assert.fail("Wrangler must not run"),
        resources: { teardown: async () => assert.fail("storage must not run") },
      });
      await assert.rejects(reaper.readPull(23), pattern, name);
      gh.assertDone();
    }

    const failed = ghFixture([{ error: new Error("gh 404") }]);
    const failedReaper = createPreviewReaper({ env: CF_ENV, runGh: failed.runGh, resources: {} });
    await assert.rejects(failedReaper.readPull(23), /gh 404/u);
    failed.assertDone();
  });

  it("orders Viewer, Stash, then the accepted R2/D1 storage helper", async () => {
    const pr = 31;
    const viewer = `zudo-history-stash-viewer-pr-${String(pr)}`;
    const stash = `zudo-history-stash-pr-${String(pr)}`;
    const events = [];
    const states = new Map([
      [viewer, true],
      [stash, true],
    ]);
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const name = parsed.searchParams.get("name");
      events.push(`list:${name}:${states.get(name) ? "present" : "absent"}`);
      return workerPage(states.get(name) ? [name] : []);
    };
    const runWrangler = async (args) => {
      const name = args[2];
      events.push(`delete:${name}`);
      states.set(name, false);
      return "success";
    };
    const resources = {
      async teardown(receivedPr) {
        events.push(`storage:${String(receivedPr)}`);
        return { d1: "deleted", r2: { deletedObjects: 2, status: "deleted" } };
      },
    };
    const reaper = createPreviewReaper({ env: CF_ENV, fetchImpl, resources, runWrangler });
    assert.deepEqual(await reaper.teardown(pr), {
      d1: "deleted",
      pr,
      r2: { deletedObjects: 2, status: "deleted" },
      stash: "deleted",
      viewer: "deleted",
    });
    assert.deepEqual(events, [
      `list:${viewer}:present`,
      `delete:${viewer}`,
      `list:${viewer}:absent`,
      `list:${stash}:present`,
      `delete:${stash}`,
      `list:${stash}:absent`,
      `storage:${String(pr)}`,
    ]);
  });

  it("stops after an unresolved Viewer failure", async () => {
    const pr = 32;
    const viewer = `zudo-history-stash-viewer-pr-${String(pr)}`;
    const fetches = fetchFixture([
      {
        path: `/workers/scripts-search?name=${viewer}&page=1&per_page=100`,
        response: workerPage([viewer]),
      },
      {
        path: `/workers/scripts-search?name=${viewer}&page=1&per_page=100`,
        response: workerPage([viewer]),
      },
    ]);
    const wrangler = wranglerFixture([
      { args: ["delete", "--name", viewer, "--force"], error: new Error("blocked") },
    ]);
    let storageCalls = 0;
    const reaper = createPreviewReaper({
      env: CF_ENV,
      fetchImpl: fetches.fetchImpl,
      runWrangler: wrangler.runWrangler,
      resources: { teardown: async () => (storageCalls += 1) },
    });
    await assert.rejects(reaper.teardown(pr), /still exists/u);
    assert.equal(storageCalls, 0);
    fetches.assertDone();
    wrangler.assertDone();
  });

  it("retries a partial Viewer-success/Stash-failure teardown idempotently", async () => {
    const pr = 33;
    const viewer = `zudo-history-stash-viewer-pr-${String(pr)}`;
    const stash = `zudo-history-stash-pr-${String(pr)}`;
    const present = new Map([
      [viewer, true],
      [stash, true],
    ]);
    const events = [];
    let stashAttempts = 0;
    const fetchImpl = async (url) => {
      const name = new URL(url).searchParams.get("name");
      events.push(`list:${name}:${present.get(name) ? "present" : "absent"}`);
      return workerPage(present.get(name) ? [name] : []);
    };
    const runWrangler = async (args) => {
      const name = args[2];
      events.push(`delete:${name}`);
      if (name === stash && stashAttempts++ === 0) throw new Error("transient stash failure");
      present.set(name, false);
      return "success";
    };
    let storageCalls = 0;
    const resources = {
      async teardown() {
        storageCalls += 1;
        events.push("storage");
        return { d1: "deleted", r2: { deletedObjects: 0, status: "deleted" } };
      },
    };
    const reaper = createPreviewReaper({ env: CF_ENV, fetchImpl, resources, runWrangler });

    await assert.rejects(reaper.teardown(pr), /still exists/u);
    assert.equal(present.get(viewer), false);
    assert.equal(present.get(stash), true);
    assert.equal(storageCalls, 0);

    assert.equal((await reaper.teardown(pr)).viewer, "absent");
    assert.equal(present.get(stash), false);
    assert.equal(storageCalls, 1);
    assert.equal(events.indexOf("storage") > events.lastIndexOf(`list:${stash}:absent`), true);
  });
});

describe("workflow contracts", () => {
  it("pins byte-identical deploy/teardown concurrency and disjoint reaper serialization", async () => {
    const [deploy, teardown, reaper] = await Promise.all([
      readFile(DEPLOY_WORKFLOW, "utf8"),
      readFile(TEARDOWN_WORKFLOW, "utf8"),
      readFile(REAPER_WORKFLOW, "utf8"),
    ]);
    const groups = (source) =>
      [...source.matchAll(/^\s+group: (preview-.*)$/gmu)].map((match) => match[1]);
    const expected =
      "preview-${{ github.event.pull_request.number || github.event.inputs.pr || github.run_id }}";
    assert.deepEqual(groups(deploy), [expected]);
    assert.equal(groups(teardown)[0], expected);
    assert.equal(groups(teardown)[0], groups(deploy)[0]);
    assert.match(reaper, /group: preview-reaper/u);
    assert.match(reaper, /group: preview-\$\{\{ matrix\.pr \}\}/u);
    assert.match(reaper, /max-parallel: 1/u);
    assert.match(reaper, /fail-fast: false/u);

    const resolveGroup = ({ dispatchPr, pr, runId }) =>
      `preview-${String(pr || dispatchPr || runId)}`;
    assert.equal(resolveGroup({ pr: 12, runId: 99 }), resolveGroup({ dispatchPr: 12, runId: 100 }));
    assert.notEqual(
      resolveGroup({ pr: 12, runId: 99 }),
      resolveGroup({ dispatchPr: 13, runId: 99 }),
    );
  });

  it("uses trusted refs, least privilege, strict gates, and exact teardown ordering", async () => {
    const [deploy, teardown, reaper, helper] = await Promise.all([
      readFile(DEPLOY_WORKFLOW, "utf8"),
      readFile(TEARDOWN_WORKFLOW, "utf8"),
      readFile(REAPER_WORKFLOW, "utf8"),
      readFile(resolve(REPOSITORY_ROOT, "scripts/preview-reaper.mjs"), "utf8"),
    ]);
    for (const source of [deploy, teardown, reaper]) {
      assert.equal(source.includes("pull_request_target"), false);
      assert.equal(source.includes("continue-on-error"), false);
      assert.equal(source.includes("|| true"), false);
      for (const use of source.matchAll(/^\s+uses: (\S+)/gmu)) {
        assert.match(use[1], /@[a-f0-9]{40}$/u);
      }
    }

    assert.match(teardown, /types: \[closed\]/u);
    assert.match(
      teardown,
      /workflow_dispatch:[\s\S]*?pr:[\s\S]*?required: true[\s\S]*?type: number/u,
    );
    assert.match(teardown, /contents: read\n\s+pull-requests: write/u);
    assert.match(
      teardown,
      /- name: Setup Node\.js\n\s+uses: actions\/setup-node@[a-f0-9]{40}[^\n]*\n\s+with:\n\s+node-version: 22\.13\.0\n\s+package-manager-cache: false\n\n\s+- name: Require an exact closed pull request/u,
    );
    assert.equal((teardown.match(/persist-credentials: false/gu) ?? []).length, 2);
    assert.equal(
      (
        teardown.match(
          /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/gu,
        ) ?? []
      ).length,
      2,
    );
    const recheck = teardown.indexOf(
      "- name: Recheck pull request after acquiring the preview lock",
    );
    const remove = teardown.indexOf("- name: Delete and verify preview resources");
    const comment = teardown.indexOf("- name: Mark preview comment torn down");
    assert.ok(recheck > 0 && remove > recheck && comment > remove);

    const viewer = helper.indexOf("deleteWorkerVerified(names.viewerWorker)");
    const stash = helper.indexOf("deleteWorkerVerified(names.stashWorker)");
    const storage = helper.indexOf("storage.teardown(pr)");
    assert.ok(viewer > 0 && stash > viewer && storage > stash);
    const broken = helper.replace(
      "const viewer = await deleteWorkerVerified(names.viewerWorker);\n    const stash = await deleteWorkerVerified(names.stashWorker);",
      "const stash = await deleteWorkerVerified(names.stashWorker);\n    const viewer = await deleteWorkerVerified(names.viewerWorker);",
    );
    assert.equal(
      broken.indexOf("deleteWorkerVerified(names.viewerWorker)") <
        broken.indexOf("deleteWorkerVerified(names.stashWorker)"),
      false,
    );

    assert.match(reaper, /schedule:\n\s+- cron: "17 3 \* \* 0"/u);
    assert.match(reaper, /workflow_dispatch:/u);
    assert.match(reaper, /contents: read\n\s+pull-requests: read/u);
    assert.match(
      reaper,
      /- name: Setup Node\.js\n\s+uses: actions\/setup-node@[a-f0-9]{40}[^\n]*\n\s+with:\n\s+node-version: 22\.13\.0\n\s+package-manager-cache: false\n\n\s+- name: Recheck pull request after acquiring the preview lock/u,
    );
    assert.equal(reaper.includes("preview-comment.mjs"), false);
    assert.equal((reaper.match(/persist-credentials: false/gu) ?? []).length, 3);
    assert.equal(
      (reaper.match(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/gu) ?? []).length,
      3,
    );
    const inventory = reaper.indexOf("- name: Inventory every preview resource class");
    const matrixRecheck = reaper.indexOf(
      "- name: Recheck pull request after acquiring the preview lock",
    );
    const matrixDelete = reaper.lastIndexOf("- name: Delete and verify preview resources");
    const failed = reaper.indexOf("- name: Report failed preview cleanup");
    assert.ok(
      inventory > 0 &&
        matrixRecheck > inventory &&
        matrixDelete > matrixRecheck &&
        failed > matrixDelete,
    );
    assert.match(reaper.slice(failed), /if: failure\(\)/u);
    assert.match(reaper.slice(failed), /Failed to clean preview resources for PR %s/u);
  });

  it("keeps Cloudflare and GitHub authority on only the intended steps", async () => {
    const [teardown, reaper] = await Promise.all([
      readFile(TEARDOWN_WORKFLOW, "utf8"),
      readFile(REAPER_WORKFLOW, "utf8"),
    ]);
    const step = (source, name) =>
      source.match(new RegExp(`- name: ${name}\\n[\\s\\S]*?(?=\\n\\s{6}- name:|$)`, "u"))?.[0];

    for (const [source, cfSteps, ghSteps] of [
      [
        teardown,
        ["Check preview credentials", "Delete and verify preview resources"],
        [
          "Require an exact closed pull request",
          "Recheck pull request after acquiring the preview lock",
          "Mark preview comment torn down",
        ],
      ],
      [
        reaper,
        [
          "Check preview credentials",
          "Inventory every preview resource class",
          "Delete and verify preview resources",
        ],
        ["Recheck pull request after acquiring the preview lock"],
      ],
    ]) {
      for (const name of cfSteps) {
        const block = step(source, name);
        assert.ok(block, `${name} exists`);
        assert.match(block, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
        assert.match(block, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
        assert.equal(block.includes("GH_TOKEN:"), false);
      }
      for (const name of ghSteps) {
        const block = step(source, name);
        assert.ok(block, `${name} exists`);
        assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
        assert.equal(block.includes("secrets.CLOUDFLARE"), false);
      }
      const secretLines = source.split("\n").filter((line) => line.includes("secrets."));
      assert.equal(secretLines.length, cfSteps.length * 2);
    }
  });
});
