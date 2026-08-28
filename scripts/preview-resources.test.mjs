import assert from "node:assert/strict";
import test from "node:test";

import {
  cfApi,
  createPreviewResources,
  dryRunPlan,
  encodeR2ObjectKey,
  previewResourceNames,
  runCli,
} from "./preview-resources.mjs";

const API_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_API_TOKEN: "api-token",
};

function apiResponse(result, resultInfo) {
  return new Response(
    JSON.stringify({
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
      success: true,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function apiError(status, message) {
  return new Response(
    JSON.stringify({
      errors: [{ code: 10_000 + status, message }],
      messages: [],
      result: null,
      success: false,
    }),
    { headers: { "content-type": "application/json" }, status },
  );
}

function sequentialWrangler(outputs) {
  const calls = [];
  const runWrangler = async (args) => {
    calls.push([...args]);
    assert.notEqual(outputs.length, 0, `Unexpected Wrangler call: ${args.join(" ")}`);
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    return typeof output === "function" ? output(args) : output;
  };
  return { calls, outputs, runWrangler };
}

function sequentialFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ init, url: new URL(String(input)) });
    assert.notEqual(responses.length, 0, `Unexpected fetch: ${String(input)}`);
    const response = responses.shift();
    return typeof response === "function" ? response(input, init) : response;
  };
  return { calls, fetchImpl, responses };
}

function assertAllConsumed(sequence) {
  assert.equal(sequence.outputs?.length ?? sequence.responses?.length, 0);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("ensure creates absent D1 and R2 resources and takes the D1 id only from the relist", async () => {
  const names = previewResourceNames(17);
  const wrangler = sequentialWrangler([
    JSON.stringify([{ name: `${names.d1Database}-old`, uuid: "other-id" }]),
    `Created ${names.d1Database} with misleading-human-id`,
    JSON.stringify([
      { name: names.d1Database, uuid: "authoritative-d1-id" },
      { name: `${names.d1Database}-copy`, uuid: "copy-id" },
    ]),
  ]);
  const fetch = sequentialFetch([
    apiResponse({ buckets: [{ name: `${names.r2Bucket}-old` }] }),
    apiResponse({ name: names.r2Bucket }),
    apiResponse({ buckets: [{ name: names.r2Bucket }] }),
  ]);
  const resources = createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  });

  const result = await resources.ensure(17);

  assert.deepEqual(result, {
    d1Id: "authoritative-d1-id",
    d1Name: names.d1Database,
    r2Bucket: names.r2Bucket,
  });
  assert.deepEqual(wrangler.calls, [
    ["d1", "list", "--json"],
    ["d1", "create", names.d1Database],
    ["d1", "list", "--json"],
  ]);
  assert.equal(fetch.calls[0].init.method, "GET");
  assert.equal(fetch.calls[0].url.pathname, "/client/v4/accounts/account-id/r2/buckets");
  assert.equal(fetch.calls[0].url.searchParams.get("name_contains"), names.r2Bucket);
  assert.equal(fetch.calls[0].url.searchParams.get("per_page"), "1000");
  assert.equal(fetch.calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body), { name: names.r2Bucket });
  assert.equal(fetch.calls[2].init.method, "GET");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer api-token");
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("ensure reuses exact existing resources without create calls", async () => {
  const names = previewResourceNames(18);
  const wrangler = sequentialWrangler([
    JSON.stringify([
      { name: names.d1Database, uuid: "existing-d1-id" },
      { name: `${names.d1Database}-suffix`, uuid: "wrong-id" },
    ]),
  ]);
  const fetch = sequentialFetch([
    apiResponse({
      buckets: [{ name: `${names.r2Bucket}-suffix` }, { name: names.r2Bucket }],
    }),
  ]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).ensure(18);

  assert.equal(result.d1Id, "existing-d1-id");
  assert.deepEqual(wrangler.calls, [["d1", "list", "--json"]]);
  assert.equal(fetch.calls.length, 1);
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("ensure rejects duplicate exact D1 names before touching R2", async () => {
  const names = previewResourceNames(19);
  const wrangler = sequentialWrangler([
    JSON.stringify([
      { name: names.d1Database, uuid: "first" },
      { name: names.d1Database, uuid: "second" },
    ]),
  ]);
  let fetchCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      runWrangler: wrangler.runWrangler,
    }).ensure(19),
    /multiple D1 resources/u,
  );
  assert.equal(fetchCalls, 0);
});

test("ensure rejects duplicate exact R2 names returned across pages", async () => {
  const names = previewResourceNames(20);
  const wrangler = sequentialWrangler([
    JSON.stringify([{ name: names.d1Database, uuid: "d1-id" }]),
  ]);
  const fetch = sequentialFetch([
    apiResponse({ buckets: [{ name: names.r2Bucket }] }, { cursor: "next-page" }),
    apiResponse({ buckets: [{ name: names.r2Bucket }] }),
  ]);

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: fetch.fetchImpl,
      runWrangler: wrangler.runWrangler,
    }).ensure(20),
    /multiple R2 bucket resources/u,
  );
  assert.equal(fetch.calls[1].url.searchParams.get("cursor"), "next-page");
  assertAllConsumed(fetch);
});

test("ensure accepts a failed D1 create only when the authoritative relist finds one exact match", async () => {
  const names = previewResourceNames(21);
  const wrangler = sequentialWrangler([
    JSON.stringify([]),
    new Error("create raced"),
    JSON.stringify([{ name: names.d1Database, uuid: "racing-winner-id" }]),
  ]);
  const fetch = sequentialFetch([apiResponse({ buckets: [{ name: names.r2Bucket }] })]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).ensure(21);

  assert.equal(result.d1Id, "racing-winner-id");
  assert.deepEqual(wrangler.calls, [
    ["d1", "list", "--json"],
    ["d1", "create", names.d1Database],
    ["d1", "list", "--json"],
  ]);
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("ensure rethrows a failed D1 create when the authoritative relist is still absent", async () => {
  const names = previewResourceNames(22);
  const wrangler = sequentialWrangler([
    JSON.stringify([]),
    new Error("original D1 create failure"),
    JSON.stringify([{ name: `${names.d1Database}-fuzzy`, uuid: "wrong" }]),
  ]);
  let fetchCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
      runWrangler: wrangler.runWrangler,
    }).ensure(22),
    /original D1 create failure/u,
  );
  assert.equal(fetchCalls, 0);
  assertAllConsumed(wrangler);
});

test("ensure accepts an R2 create conflict only when the exact relist finds the bucket", async () => {
  const names = previewResourceNames(23);
  const wrangler = sequentialWrangler([
    JSON.stringify([{ name: names.d1Database, uuid: "d1-id" }]),
  ]);
  const fetch = sequentialFetch([
    apiResponse({ buckets: [] }),
    apiError(409, "bucket was created concurrently"),
    apiResponse({ buckets: [{ name: names.r2Bucket }] }),
  ]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).ensure(23);

  assert.equal(result.r2Bucket, names.r2Bucket);
  assert.deepEqual(
    fetch.calls.map((call) => call.init.method),
    ["GET", "POST", "GET"],
  );
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("teardown empties two object pages, confirms empty, deletes R2, then deletes D1", async () => {
  const names = previewResourceNames(24);
  const wrangler = sequentialWrangler([
    JSON.stringify([{ name: names.d1Database, uuid: "d1-id" }]),
    "Deleted database",
    JSON.stringify([]),
  ]);
  const fetch = sequentialFetch([
    apiResponse([{ key: "plain.txt" }], { cursor: "page two", is_truncated: true }),
    apiResponse([{ key: "dir/日本語/a b?#'()!.txt" }], { is_truncated: false }),
    apiResponse({ key: "plain.txt" }),
    apiResponse({ key: "dir/日本語/a b?#'()!.txt" }),
    apiResponse([], { is_truncated: false }),
    apiResponse({}),
  ]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).teardown(24);

  assert.deepEqual(result, { d1: "deleted", r2: { deletedObjects: 2, status: "deleted" } });
  assert.equal(fetch.calls[0].url.searchParams.get("per_page"), "1000");
  assert.equal(fetch.calls[1].url.searchParams.get("cursor"), "page two");
  assert.equal(
    fetch.calls[3].url.pathname,
    `/client/v4/accounts/account-id/r2/buckets/${names.r2Bucket}/objects/dir/%E6%97%A5%E6%9C%AC%E8%AA%9E/a%20b%3F%23%27%28%29%21.txt`,
  );
  assert.equal(fetch.calls[4].url.searchParams.get("per_page"), "1");
  assert.equal(fetch.calls[4].url.searchParams.has("cursor"), false);
  assert.equal(fetch.calls[5].url.pathname.endsWith(`/r2/buckets/${names.r2Bucket}`), true);
  assert.deepEqual(
    fetch.calls.map((call) => call.init.method),
    ["GET", "GET", "DELETE", "DELETE", "GET", "DELETE"],
  );
  assert.deepEqual(wrangler.calls, [
    ["d1", "list", "--json"],
    ["d1", "delete", names.d1Database, "--skip-confirmation"],
    ["d1", "list", "--json"],
  ]);
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("teardown tolerates literal 404 deletes and continues to D1", async () => {
  const names = previewResourceNames(25);
  const wrangler = sequentialWrangler([JSON.stringify([])]);
  const fetch = sequentialFetch([
    apiResponse([{ key: "already-gone.txt" }], { is_truncated: false }),
    new Response("not JSON and already gone", { status: 404 }),
    apiResponse([], { is_truncated: false }),
    apiError(404, "bucket not found"),
  ]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).teardown(25);

  assert.deepEqual(result, { d1: "absent", r2: { deletedObjects: 0, status: "absent" } });
  assert.deepEqual(wrangler.calls, [["d1", "list", "--json"]]);
  assert.equal(fetch.calls[1].url.pathname.endsWith("/objects/already-gone.txt"), true);
  assert.equal(fetch.calls[3].url.pathname.endsWith(`/r2/buckets/${names.r2Bucket}`), true);
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("teardown treats a 403 saying not found as fatal and stops before D1", async () => {
  const fetch = sequentialFetch([
    apiResponse([{ key: "protected.txt" }], { is_truncated: false }),
    apiError(403, "not found because access is forbidden"),
  ]);
  let wranglerCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: fetch.fetchImpl,
      runWrangler: async () => {
        wranglerCalls += 1;
        throw new Error("Wrangler must not run after the R2 failure");
      },
    }).teardown(26),
    /failed \(403\).*not found because access is forbidden/u,
  );
  assert.equal(wranglerCalls, 0);
  assertAllConsumed(fetch);
});

test("teardown fails closed on malformed empty-confirmation pagination metadata", async () => {
  const fetch = sequentialFetch([
    apiResponse([], { is_truncated: false }),
    apiResponse([], "malformed-result-info"),
  ]);
  let wranglerCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: fetch.fetchImpl,
      runWrangler: async () => {
        wranglerCalls += 1;
        throw new Error("Wrangler must not run after malformed R2 state");
      },
    }).teardown(27),
    /invalid result_info/u,
  );
  assert.equal(wranglerCalls, 0);
  assertAllConsumed(fetch);
});

test("teardown rejects truncated object pages with a missing cursor before deleting", async () => {
  const fetch = sequentialFetch([
    apiResponse([{ key: "must-remain.txt" }], { is_truncated: true }),
  ]);
  let wranglerCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: fetch.fetchImpl,
      runWrangler: async () => {
        wranglerCalls += 1;
        throw new Error("Wrangler must not run after malformed R2 pagination");
      },
    }).teardown(32),
    /truncated without a cursor/u,
  );
  assert.equal(
    fetch.calls.some((call) => call.init.method === "DELETE"),
    false,
  );
  assert.equal(wranglerCalls, 0);
  assertAllConsumed(fetch);
});

test("teardown rejects a repeated object cursor before deleting or looping", async () => {
  const fetch = sequentialFetch([
    apiResponse([{ key: "first.txt" }], { cursor: "same", is_truncated: true }),
    apiResponse([{ key: "second.txt" }], { cursor: "same", is_truncated: true }),
  ]);
  let wranglerCalls = 0;

  await assert.rejects(
    createPreviewResources({
      env: API_ENV,
      fetchImpl: fetch.fetchImpl,
      runWrangler: async () => {
        wranglerCalls += 1;
        throw new Error("Wrangler must not run after repeated R2 pagination");
      },
    }).teardown(33),
    /repeated cursor/u,
  );
  assert.equal(fetch.calls.length, 2);
  assert.equal(
    fetch.calls.some((call) => call.init.method === "DELETE"),
    false,
  );
  assert.equal(wranglerCalls, 0);
  assertAllConsumed(fetch);
});

test("teardown awaits each object deletion so the delete fanout stays bounded", async () => {
  const names = previewResourceNames(34);
  const firstDeleteStarted = deferred();
  const releaseFirstDelete = deferred();
  const calls = [];
  let activeObjectDeletes = 0;
  let maximumObjectDeletes = 0;

  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init.method, url });
    const isObjectPath = url.pathname.includes(`/r2/buckets/${names.r2Bucket}/objects`);
    if (init.method === "GET" && url.searchParams.get("per_page") === "1000") {
      return apiResponse([{ key: "first.txt" }, { key: "second.txt" }], {
        is_truncated: false,
      });
    }
    if (init.method === "DELETE" && isObjectPath) {
      activeObjectDeletes += 1;
      maximumObjectDeletes = Math.max(maximumObjectDeletes, activeObjectDeletes);
      if (url.pathname.endsWith("/first.txt")) {
        firstDeleteStarted.resolve();
        await releaseFirstDelete.promise;
      }
      activeObjectDeletes -= 1;
      return apiResponse({ key: url.pathname.split("/").at(-1) });
    }
    if (init.method === "GET" && url.searchParams.get("per_page") === "1") {
      return apiResponse([], { is_truncated: false });
    }
    if (init.method === "DELETE" && url.pathname.endsWith(`/r2/buckets/${names.r2Bucket}`)) {
      return apiResponse({});
    }
    throw new Error(`Unexpected fetch: ${init.method} ${url.href}`);
  };
  const wrangler = sequentialWrangler([JSON.stringify([])]);
  const teardown = createPreviewResources({
    env: API_ENV,
    fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).teardown(34);

  await firstDeleteStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    calls.filter((call) => call.method === "DELETE" && call.url.pathname.includes("/objects/"))
      .length,
    1,
  );
  releaseFirstDelete.resolve();

  const result = await teardown;
  assert.equal(maximumObjectDeletes, 1);
  assert.deepEqual(result, { d1: "absent", r2: { deletedObjects: 2, status: "deleted" } });
  assertAllConsumed(wrangler);
});

test("a failed D1 deletion is tolerated only after an exact relist proves absence", async () => {
  const names = previewResourceNames(28);
  const wrangler = sequentialWrangler([
    JSON.stringify([{ name: names.d1Database, uuid: "d1-id" }]),
    new Error("ambiguous delete failure"),
    JSON.stringify([]),
  ]);
  const fetch = sequentialFetch([apiError(404, "bucket not found")]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
    runWrangler: wrangler.runWrangler,
  }).teardown(28);

  assert.deepEqual(result, { d1: "absent", r2: { deletedObjects: 0, status: "absent" } });
  assert.deepEqual(wrangler.calls, [
    ["d1", "list", "--json"],
    ["d1", "delete", names.d1Database, "--skip-confirmation"],
    ["d1", "list", "--json"],
  ]);
  assertAllConsumed(wrangler);
  assertAllConsumed(fetch);
});

test("urls uses CF_WORKERS_SUBDOMAIN without credentials or an API request", async () => {
  let fetchCalls = 0;
  const result = await createPreviewResources({
    env: { CF_WORKERS_SUBDOMAIN: " Preview-Team " },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    },
  }).urls(29);

  assert.deepEqual(result, {
    stashUrl: "https://zudo-history-stash-pr-29.preview-team.workers.dev",
    viewerUrl: "https://zudo-history-stash-viewer-pr-29.preview-team.workers.dev",
  });
  assert.equal(fetchCalls, 0);
});

test("urls gets the account Workers subdomain from the structured API response", async () => {
  const fetch = sequentialFetch([apiResponse({ subdomain: "api-team" })]);

  const result = await createPreviewResources({
    env: API_ENV,
    fetchImpl: fetch.fetchImpl,
  }).urls(30);

  assert.equal(result.stashUrl, "https://zudo-history-stash-pr-30.api-team.workers.dev");
  assert.equal(fetch.calls[0].url.pathname, "/client/v4/accounts/account-id/workers/subdomain");
  assertAllConsumed(fetch);
});

test("cfApi accepts only a literal 404 as allowed not-found", async () => {
  const missing = await cfApi("/r2/buckets/missing", {
    allowNotFound: true,
    env: API_ENV,
    fetchImpl: async () => apiError(404, "not found"),
    method: "DELETE",
  });
  assert.deepEqual(missing, { found: false });

  await assert.rejects(
    cfApi("/r2/buckets/forbidden", {
      allowNotFound: true,
      env: API_ENV,
      fetchImpl: async () => apiError(403, "not found"),
      method: "DELETE",
    }),
    /failed \(403\)/u,
  );
});

test("cfApi rejects 2xx success:false and malformed JSON responses", async () => {
  await assert.rejects(
    cfApi("/r2/buckets", {
      env: API_ENV,
      fetchImpl: async () => apiError(200, "logical API failure"),
    }),
    /GET \/r2\/buckets failed \(200\).*10200: logical API failure/u,
  );

  await assert.rejects(
    cfApi("/r2/buckets", {
      env: API_ENV,
      fetchImpl: async () => new Response("{not-json", { status: 200 }),
    }),
    /returned invalid JSON \(200\)/u,
  );
});

test("dry-run plans every subcommand deterministically without fetch or Wrangler effects", async () => {
  const sideEffects = [];
  const outputs = {};
  for (const command of ["ensure", "teardown", "urls"]) {
    const writes = [];
    const dependencies = {
      env: API_ENV,
      fetchImpl: async () => {
        sideEffects.push("fetch");
        throw new Error("fetch must not run");
      },
      runWrangler: async () => {
        sideEffects.push("wrangler");
        throw new Error("Wrangler must not run");
      },
      writeLine: (line) => writes.push(line),
    };
    const first = await runCli([command, "--pr", "31", "--dry-run"], dependencies);
    await runCli([command, "--pr", "31", "--dry-run"], dependencies);
    assert.deepEqual(first, dryRunPlan(command, 31, API_ENV));
    assert.equal(writes[0], writes[1]);
    assert.equal(writes.join("\n").includes(API_ENV.CLOUDFLARE_API_TOKEN), false);
    assert.equal(writes.join("\n").includes(API_ENV.CLOUDFLARE_ACCOUNT_ID), false);
    outputs[command] = first;
  }

  assert.deepEqual(sideEffects, []);
  assert.deepEqual(outputs.ensure.calls[0], {
    args: ["d1", "list", "--json"],
    kind: "wrangler",
  });
  assert.equal(
    outputs.teardown.calls.some(
      (call) => call.kind === "cloudflare-api" && call.purpose === "confirm empty",
    ),
    true,
  );
  assert.deepEqual(outputs.urls.calls, [
    { kind: "cloudflare-api", method: "GET", path: "/workers/subdomain" },
  ]);
});

test("R2 object key encoding preserves path slashes and escapes all other RFC 3986 reserved chars", () => {
  assert.equal(encodeR2ObjectKey("dir/a b?#'()!.txt"), "dir/a%20b%3F%23%27%28%29%21.txt");
  assert.equal(encodeR2ObjectKey("dir/日本語/é.txt"), "dir/%E6%97%A5%E6%9C%AC%E8%AA%9E/%C3%A9.txt");
});
