#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4";
const R2_PAGE_SIZE = 1_000;

function usage() {
  return "Usage: node scripts/preview-resources.mjs <ensure|teardown|urls> --pr N [--dry-run]";
}

function parsePr(value) {
  if (!/^[1-9]\d*$/u.test(value ?? "")) throw new Error("--pr must be a positive integer");
  const pr = Number(value);
  if (!Number.isSafeInteger(pr)) throw new Error("--pr must be a safe positive integer");
  return pr;
}

export function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };

  const [command, ...options] = argv;
  if (!new Set(["ensure", "teardown", "urls"]).has(command)) {
    throw new Error(usage());
  }

  let dryRun = false;
  let pr;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be specified once");
      dryRun = true;
      continue;
    }
    if (option === "--pr") {
      if (pr !== undefined) throw new Error("--pr may only be specified once");
      pr = parsePr(options[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${option}`);
  }

  if (pr === undefined) throw new Error("--pr is required");
  return { command, dryRun, help: false, pr };
}

export function previewResourceNames(pr) {
  const validatedPr = parsePr(String(pr));
  return {
    d1Database: `zudo-history-stash-pr-${validatedPr}`,
    r2Bucket: `zudo-history-stash-blobs-pr-${validatedPr}`,
    stashWorker: `zudo-history-stash-pr-${validatedPr}`,
    viewerWorker: `zudo-history-stash-viewer-pr-${validatedPr}`,
  };
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cloudflareErrorDetails(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.errors)) return "";
  const messages = payload.errors
    .map((error) => {
      if (!error || typeof error !== "object") return "";
      const code = typeof error.code === "number" ? `${error.code}: ` : "";
      return typeof error.message === "string" ? `${code}${error.message}` : "";
    })
    .filter(Boolean);
  return messages.length > 0 ? ` (${messages.join("; ")})` : "";
}

export async function cfApi(
  path,
  {
    allowNotFound = false,
    body,
    env = process.env,
    fetchImpl = globalThis.fetch,
    method = "GET",
  } = {},
) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Cloudflare API path must be account-relative and start with one slash");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const token = requiredEnv(env, "CLOUDFLARE_API_TOKEN");
  const accountId = requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID");
  const url = `${CLOUDFLARE_API_ROOT}/accounts/${encodeURIComponent(accountId)}${path}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  let requestBody;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetchImpl(url, { body: requestBody, headers, method });
  const responseText = await response.text();
  let payload;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      if (response.status === 404 && allowNotFound) return { found: false };
      throw new Error(
        `Cloudflare API ${method} ${path} returned invalid JSON (${response.status})`,
      );
    }
  }

  if (response.status === 404 && allowNotFound) return { found: false };
  if (!response.ok) {
    throw new Error(
      `Cloudflare API ${method} ${path} failed (${response.status})${cloudflareErrorDetails(payload)}`,
    );
  }
  if (payload && typeof payload === "object" && payload.success === false) {
    throw new Error(
      `Cloudflare API ${method} ${path} failed (${response.status})${cloudflareErrorDetails(payload)}`,
    );
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.success !== true ||
    !("result" in payload)
  ) {
    throw new Error(`Cloudflare API ${method} ${path} returned an invalid success envelope`);
  }

  return { found: true, result: payload.result, resultInfo: payload.result_info };
}

async function defaultRunWrangler(args) {
  const result = await execFileAsync("pnpm", ["exec", "wrangler", ...args], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

function wranglerStdout(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.stdout === "string") {
    return result.stdout;
  }
  throw new Error("Wrangler command returned no stdout string");
}

function parseD1Databases(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("wrangler d1 list --json returned invalid JSON");
  }
  if (!Array.isArray(value)) throw new Error("wrangler d1 list --json returned a non-array");
  for (const database of value) {
    if (!database || typeof database !== "object" || typeof database.name !== "string") {
      throw new Error("wrangler d1 list --json returned an invalid database entry");
    }
  }
  return value;
}

function exactMatches(items, name, label) {
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1) throw new Error(`Found multiple ${label} resources named ${name}`);
  return matches;
}

function d1DatabaseId(database, name) {
  const id = database.uuid;
  if (typeof id !== "string" || !id || id.trim() !== id) {
    throw new Error(`D1 database ${name} has no structured uuid`);
  }
  return id;
}

function queryPath(path, entries) {
  const search = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) search.set(name, String(value));
  }
  return `${path}?${search.toString()}`;
}

function nextCursor(resultInfo, label, seenCursors) {
  if (resultInfo === undefined || resultInfo === null) return undefined;
  if (typeof resultInfo !== "object" || Array.isArray(resultInfo)) {
    throw new Error(`${label} returned invalid result_info`);
  }
  const cursor = resultInfo.cursor;
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  if (typeof cursor !== "string") throw new Error(`${label} returned a non-string cursor`);
  if (seenCursors.has(cursor)) throw new Error(`${label} returned a repeated cursor`);
  seenCursors.add(cursor);
  return cursor;
}

function parseR2Buckets(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Cloudflare R2 bucket list returned an invalid result");
  }
  const buckets = result.buckets ?? [];
  if (!Array.isArray(buckets)) throw new Error("Cloudflare R2 bucket list returned a non-array");
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object" || typeof bucket.name !== "string") {
      throw new Error("Cloudflare R2 bucket list returned an invalid bucket entry");
    }
  }
  return buckets;
}

function parseR2Objects(result) {
  if (!Array.isArray(result)) throw new Error("Cloudflare R2 object list returned a non-array");
  return result.map((object) => {
    if (!object || typeof object !== "object" || typeof object.key !== "string" || !object.key) {
      throw new Error("Cloudflare R2 object list returned an invalid object entry");
    }
    return object;
  });
}

function validateR2ObjectResultInfo(resultInfo) {
  if (resultInfo === undefined || resultInfo === null) return undefined;
  if (typeof resultInfo !== "object" || Array.isArray(resultInfo)) {
    throw new Error("Cloudflare R2 object list returned invalid result_info");
  }
  if (resultInfo.is_truncated !== undefined && typeof resultInfo.is_truncated !== "boolean") {
    throw new Error("Cloudflare R2 object list returned a non-boolean is_truncated");
  }
  return resultInfo;
}

function encodeRfc3986Segment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeR2ObjectKey(key) {
  if (typeof key !== "string" || !key) throw new Error("R2 object key must be non-empty");
  return key.split("/").map(encodeRfc3986Segment).join("/");
}

function normalizeWorkersSubdomain(value) {
  const subdomain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new Error("Workers subdomain must be a single valid DNS label");
  }
  return subdomain;
}

function outputUrls(names, subdomain) {
  return {
    stashUrl: `https://${names.stashWorker}.${subdomain}.workers.dev`,
    viewerUrl: `https://${names.viewerWorker}.${subdomain}.workers.dev`,
  };
}

export function createPreviewResources({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runWrangler = defaultRunWrangler,
} = {}) {
  const api = (path, options = {}) => cfApi(path, { ...options, env, fetchImpl });

  async function listD1Exact(name) {
    const result = await runWrangler(["d1", "list", "--json"]);
    return exactMatches(parseD1Databases(wranglerStdout(result)), name, "D1");
  }

  async function ensureD1(name) {
    let matches = await listD1Exact(name);
    if (matches.length === 0) {
      // The create command only emits human-oriented output in the pinned Wrangler version.
      // Deliberately ignore it and obtain the id from a second structured list operation.
      let createFailed = false;
      let createFailure;
      try {
        await runWrangler(["d1", "create", name]);
      } catch (error) {
        // A competing ensure may have won after our first list. Only a structured exact relist
        // can turn the failed prose-oriented create into success.
        createFailed = true;
        createFailure = error;
      }
      matches = await listD1Exact(name);
      if (matches.length === 0 && createFailed) throw createFailure;
    }
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one D1 database named ${name} after ensure`);
    }
    return d1DatabaseId(matches[0], name);
  }

  async function listR2Exact(name) {
    const buckets = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const path = queryPath("/r2/buckets", [
        ["name_contains", name],
        ["per_page", R2_PAGE_SIZE],
        ["cursor", cursor],
      ]);
      const response = await api(path);
      buckets.push(...parseR2Buckets(response.result));
      cursor = nextCursor(response.resultInfo, "Cloudflare R2 bucket list", seenCursors);
    } while (cursor !== undefined);
    return exactMatches(buckets, name, "R2 bucket");
  }

  async function ensureR2(name) {
    let matches = await listR2Exact(name);
    if (matches.length === 0) {
      let createFailed = false;
      let createFailure;
      try {
        await api("/r2/buckets", { body: { name }, method: "POST" });
      } catch (error) {
        createFailed = true;
        createFailure = error;
      }
      matches = await listR2Exact(name);
      if (matches.length === 0 && createFailed) throw createFailure;
    }
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one R2 bucket named ${name} after ensure`);
    }
  }

  async function ensure(pr) {
    const names = previewResourceNames(pr);
    const d1Id = await ensureD1(names.d1Database);
    await ensureR2(names.r2Bucket);
    return { d1Id, d1Name: names.d1Database, r2Bucket: names.r2Bucket };
  }

  async function listObjectPage(bucket, cursor, allowNotFound) {
    const path = queryPath(`/r2/buckets/${encodeURIComponent(bucket)}/objects`, [
      ["per_page", R2_PAGE_SIZE],
      ["cursor", cursor],
    ]);
    const response = await api(path, { allowNotFound });
    if (!response.found) return response;
    const objects = parseR2Objects(response.result);
    const resultInfo = validateR2ObjectResultInfo(response.resultInfo);
    return { found: true, objects, resultInfo };
  }

  async function emptyAndDeleteR2(bucket) {
    const seenCursors = new Set();
    const objectKeys = new Set();
    let cursor;
    let deletedObjects = 0;
    do {
      const page = await listObjectPage(bucket, cursor, true);
      if (!page.found) return { deletedObjects, status: "absent" };
      for (const object of page.objects) objectKeys.add(object.key);

      const truncated = page.resultInfo?.is_truncated;
      const pageCursor = nextCursor(page.resultInfo, "Cloudflare R2 object list", seenCursors);
      if (truncated === false && pageCursor !== undefined) {
        throw new Error("Cloudflare R2 object list returned a cursor for a final page");
      }
      if (truncated === true && pageCursor === undefined) {
        throw new Error("Cloudflare R2 object list was truncated without a cursor");
      }
      // Older API envelopes can omit is_truncated; a cursor still authoritatively indicates
      // another page. Do not mutate the listing while consuming its opaque cursors.
      cursor = truncated === false ? undefined : pageCursor;
    } while (cursor !== undefined);

    for (const key of objectKeys) {
      const path = `/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeR2ObjectKey(key)}`;
      const deletion = await api(path, { allowNotFound: true, method: "DELETE" });
      if (deletion.found) deletedObjects += 1;
    }

    const confirmationPath = queryPath(`/r2/buckets/${encodeURIComponent(bucket)}/objects`, [
      ["per_page", 1],
    ]);
    const confirmation = await api(confirmationPath, { allowNotFound: true });
    if (!confirmation.found) return { deletedObjects, status: "absent" };
    const remaining = parseR2Objects(confirmation.result);
    const confirmationInfo = validateR2ObjectResultInfo(confirmation.resultInfo);
    const confirmationCursor = nextCursor(
      confirmationInfo,
      "Cloudflare R2 empty confirmation",
      new Set(),
    );
    if (
      remaining.length > 0 ||
      confirmationInfo?.is_truncated === true ||
      confirmationCursor !== undefined
    ) {
      throw new Error(`R2 bucket ${bucket} was not empty after object deletion`);
    }

    const deletion = await api(`/r2/buckets/${encodeURIComponent(bucket)}`, {
      allowNotFound: true,
      method: "DELETE",
    });
    return { deletedObjects, status: deletion.found ? "deleted" : "absent" };
  }

  async function deleteD1(name) {
    const before = await listD1Exact(name);
    if (before.length === 0) return "absent";

    try {
      await runWrangler(["d1", "delete", name, "--skip-confirmation"]);
    } catch (error) {
      const afterFailure = await listD1Exact(name);
      if (afterFailure.length === 0) return "absent";
      throw new Error(`Deleting D1 database ${name} failed and it still exists`, { cause: error });
    }

    const after = await listD1Exact(name);
    if (after.length !== 0) throw new Error(`D1 database ${name} still exists after deletion`);
    return "deleted";
  }

  async function teardown(pr) {
    const names = previewResourceNames(pr);
    const r2 = await emptyAndDeleteR2(names.r2Bucket);
    const d1 = await deleteD1(names.d1Database);
    return { d1, r2 };
  }

  async function urls(pr) {
    const names = previewResourceNames(pr);
    const configured = env.CF_WORKERS_SUBDOMAIN?.trim();
    let subdomain;
    if (configured) {
      subdomain = normalizeWorkersSubdomain(configured);
    } else {
      const response = await api("/workers/subdomain");
      if (
        !response.result ||
        typeof response.result !== "object" ||
        typeof response.result.subdomain !== "string"
      ) {
        throw new Error("Cloudflare Workers subdomain response was invalid");
      }
      subdomain = normalizeWorkersSubdomain(response.result.subdomain);
    }
    return outputUrls(names, subdomain);
  }

  return { ensure, teardown, urls };
}

function apiPlan(method, path, extra = {}) {
  return { kind: "cloudflare-api", method, path, ...extra };
}

function wranglerPlan(args, extra = {}) {
  return { kind: "wrangler", args, ...extra };
}

export function dryRunPlan(command, pr, env = process.env) {
  const names = previewResourceNames(pr);
  const plan = { command, dryRun: true, names, pr };

  if (command === "ensure") {
    return {
      ...plan,
      calls: [
        wranglerPlan(["d1", "list", "--json"]),
        wranglerPlan(["d1", "create", names.d1Database], { when: "exact D1 is absent" }),
        wranglerPlan(["d1", "list", "--json"], { when: "D1 was created" }),
        apiPlan(
          "GET",
          queryPath("/r2/buckets", [
            ["name_contains", names.r2Bucket],
            ["per_page", R2_PAGE_SIZE],
          ]),
          { repeat: "while a cursor is returned" },
        ),
        apiPlan("POST", "/r2/buckets", {
          body: { name: names.r2Bucket },
          when: "exact R2 bucket is absent",
        }),
        apiPlan(
          "GET",
          queryPath("/r2/buckets", [
            ["name_contains", names.r2Bucket],
            ["per_page", R2_PAGE_SIZE],
          ]),
          { repeat: "while a cursor is returned", when: "R2 bucket was created" },
        ),
      ],
    };
  }

  if (command === "teardown") {
    const objectListPath = queryPath(`/r2/buckets/${encodeURIComponent(names.r2Bucket)}/objects`, [
      ["per_page", R2_PAGE_SIZE],
    ]);
    return {
      ...plan,
      calls: [
        apiPlan("GET", objectListPath, { repeat: "while is_truncated is true" }),
        apiPlan(
          "DELETE",
          `/r2/buckets/${encodeURIComponent(names.r2Bucket)}/objects/<object-key>`,
          { repeat: "for each listed object" },
        ),
        apiPlan(
          "GET",
          queryPath(`/r2/buckets/${encodeURIComponent(names.r2Bucket)}/objects`, [["per_page", 1]]),
          { purpose: "confirm empty" },
        ),
        apiPlan("DELETE", `/r2/buckets/${encodeURIComponent(names.r2Bucket)}`),
        wranglerPlan(["d1", "list", "--json"]),
        wranglerPlan(["d1", "delete", names.d1Database, "--skip-confirmation"], {
          when: "exact D1 exists",
        }),
        wranglerPlan(["d1", "list", "--json"], { purpose: "confirm absent" }),
      ],
    };
  }

  const configured = env.CF_WORKERS_SUBDOMAIN?.trim();
  const subdomain = configured ? normalizeWorkersSubdomain(configured) : "<workers-subdomain>";
  return {
    ...plan,
    calls: configured ? [] : [apiPlan("GET", "/workers/subdomain")],
    result: outputUrls(names, subdomain),
  };
}

export async function runCli(
  argv,
  {
    env = process.env,
    fetchImpl = globalThis.fetch,
    runWrangler = defaultRunWrangler,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const options = parseArguments(argv);
  if (options.help) {
    writeLine(usage());
    return undefined;
  }
  if (options.dryRun) {
    const plan = dryRunPlan(options.command, options.pr, env);
    writeLine(JSON.stringify(plan, null, 2));
    return plan;
  }

  const resources = createPreviewResources({ env, fetchImpl, runWrangler });
  const result = await resources[options.command](options.pr);
  writeLine(JSON.stringify(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
