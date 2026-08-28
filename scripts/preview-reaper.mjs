#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runGh as defaultRunGh } from "./preview-comment.mjs";
import { cfApi, createPreviewResources, previewResourceNames } from "./preview-resources.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PAGE_SIZE = 100;
const R2_PAGE_SIZE = 1_000;
const MAX_WORKER_PAGES = 10_000;
const MAX_MATRIX_CANDIDATES = 256;

const RESOURCE_PATTERNS = {
  worker: [/^zudo-history-stash-pr-([1-9]\d*)$/u, /^zudo-history-stash-viewer-pr-([1-9]\d*)$/u],
  d1: [/^zudo-history-stash-pr-([1-9]\d*)$/u],
  r2: [/^zudo-history-stash-blobs-pr-([1-9]\d*)$/u],
};

function usage() {
  return "Usage: node scripts/preview-reaper.mjs <discover|check-pr|teardown> [--pr N]";
}

export function parsePreviewPr(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error("--pr must be a canonical positive integer");
  }
  const pr = Number(value);
  if (!Number.isSafeInteger(pr)) throw new Error("--pr must be a safe positive integer");
  return pr;
}

function normalizePreviewPr(value) {
  return parsePreviewPr(typeof value === "number" ? String(value) : value);
}

export function parsePreviewResourceName(kind, name) {
  const patterns = RESOURCE_PATTERNS[kind];
  if (!patterns) throw new Error(`Unknown preview resource kind: ${String(kind)}`);
  if (typeof name !== "string") throw new Error(`${kind} resource name must be a string`);
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (match) return parsePreviewPr(match[1]);
  }
  return null;
}

export function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [command, ...options] = argv;
  if (!new Set(["discover", "check-pr", "teardown"]).has(command)) {
    throw new Error(usage());
  }

  let pr;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option !== "--pr") throw new Error(`Unknown argument: ${String(option)}`);
    if (pr !== undefined) throw new Error("--pr may only be specified once");
    pr = parsePreviewPr(options[index + 1]);
    index += 1;
  }

  if (command === "discover" && pr !== undefined) throw new Error("discover does not accept --pr");
  if (command !== "discover" && pr === undefined) throw new Error("--pr is required");
  return { command, help: false, pr };
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseRepository(env) {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  return repository;
}

function stdoutText(result, label) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && typeof result.stdout === "string") {
    return result.stdout;
  }
  throw new Error(`${label} returned no stdout string`);
}

async function defaultRunWrangler(args) {
  const result = await execFileAsync("pnpm", ["exec", "wrangler", ...args], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

function queryPath(path, entries) {
  const search = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) search.set(name, String(value));
  }
  return `${path}?${search.toString()}`;
}

function safeInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function parseWorkerPage(response, requestedPage) {
  if (!Array.isArray(response.result)) {
    throw new Error("Cloudflare Worker search returned a non-array result");
  }
  const workers = response.result.map((worker) => {
    if (
      !worker ||
      typeof worker !== "object" ||
      typeof worker.script_name !== "string" ||
      !worker.script_name
    ) {
      throw new Error("Cloudflare Worker search returned an invalid worker entry");
    }
    return worker;
  });

  const info = response.resultInfo;
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new Error("Cloudflare Worker search returned invalid result_info");
  }
  const page = safeInteger(info.page, "Cloudflare Worker search page");
  if (page !== requestedPage) {
    throw new Error(
      `Cloudflare Worker search returned page ${String(page)} for page ${requestedPage}`,
    );
  }
  const totalPages = safeInteger(info.total_pages, "Cloudflare Worker search total_pages", {
    allowZero: true,
  });
  if (totalPages > MAX_WORKER_PAGES) {
    throw new Error("Cloudflare Worker search exceeded the defensive page limit");
  }
  if (totalPages === 0) {
    if (requestedPage !== 1 || workers.length !== 0) {
      throw new Error("Cloudflare Worker search returned inconsistent zero-page pagination");
    }
  } else if (totalPages < requestedPage) {
    throw new Error("Cloudflare Worker search total_pages moved behind the current page");
  }
  if (info.count !== undefined) {
    const count = safeInteger(info.count, "Cloudflare Worker search count", { allowZero: true });
    if (count !== workers.length) {
      throw new Error("Cloudflare Worker search count did not match its result length");
    }
  }
  if (info.per_page !== undefined) {
    const perPage = safeInteger(info.per_page, "Cloudflare Worker search per_page");
    if (perPage > WORKER_PAGE_SIZE) {
      throw new Error("Cloudflare Worker search per_page exceeded the requested maximum");
    }
  }
  const totalCount =
    info.total_count === undefined
      ? undefined
      : safeInteger(info.total_count, "Cloudflare Worker search total_count", {
          allowZero: true,
        });
  return { totalCount, totalPages, workers };
}

function parseD1Databases(result) {
  let parsed;
  try {
    parsed = JSON.parse(stdoutText(result, "wrangler d1 list --json"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("wrangler d1 list --json returned invalid JSON");
    }
    throw error;
  }
  if (!Array.isArray(parsed)) throw new Error("wrangler d1 list --json returned a non-array");
  return parsed.map((database) => {
    if (!database || typeof database !== "object" || typeof database.name !== "string") {
      throw new Error("wrangler d1 list --json returned an invalid database entry");
    }
    return database;
  });
}

function parseR2Buckets(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Cloudflare R2 bucket list returned an invalid result");
  }
  if (!Object.hasOwn(result, "buckets") || !Array.isArray(result.buckets)) {
    throw new Error("Cloudflare R2 bucket list returned invalid buckets");
  }
  const buckets = result.buckets;
  return buckets.map((bucket) => {
    if (!bucket || typeof bucket !== "object" || typeof bucket.name !== "string" || !bucket.name) {
      throw new Error("Cloudflare R2 bucket list returned an invalid bucket entry");
    }
    return bucket;
  });
}

function nextR2Cursor(resultInfo, seen) {
  if (!resultInfo || typeof resultInfo !== "object" || Array.isArray(resultInfo)) {
    throw new Error("Cloudflare R2 bucket list returned invalid result_info");
  }
  if (resultInfo.per_page !== undefined) {
    const perPage = safeInteger(resultInfo.per_page, "Cloudflare R2 bucket list per_page");
    if (perPage > R2_PAGE_SIZE) {
      throw new Error("Cloudflare R2 bucket list per_page exceeded the requested maximum");
    }
  }
  if (!Object.hasOwn(resultInfo, "cursor")) return undefined;
  const cursor = resultInfo.cursor;
  if (cursor === "") return undefined;
  if (typeof cursor !== "string") {
    throw new Error("Cloudflare R2 bucket list returned a non-string cursor");
  }
  if (seen.has(cursor)) throw new Error("Cloudflare R2 bucket list returned a repeated cursor");
  seen.add(cursor);
  return cursor;
}

function parsePullResponse(result, expectedPr) {
  let pull;
  try {
    pull = JSON.parse(stdoutText(result, "gh api pull request lookup"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("gh api returned malformed pull request JSON");
    throw error;
  }
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) {
    throw new Error("gh api returned malformed pull request JSON");
  }
  if (pull.number !== expectedPr)
    throw new Error("gh api returned a mismatched pull request number");
  if (pull.state !== "open" && pull.state !== "closed") {
    throw new Error("gh api returned an invalid pull request state");
  }
  if (
    !pull.head ||
    typeof pull.head !== "object" ||
    !pull.head.repo ||
    typeof pull.head.repo !== "object" ||
    typeof pull.head.repo.fork !== "boolean"
  ) {
    throw new Error("gh api returned an invalid pull request fork state");
  }
  return { fork: pull.head.repo.fork, pr: expectedPr, state: pull.state };
}

export function createPreviewReaper({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runWrangler = defaultRunWrangler,
  runGh = defaultRunGh,
  resources,
} = {}) {
  const api = (path, options = {}) => cfApi(path, { ...options, env, fetchImpl });
  const storage = resources ?? createPreviewResources({ env, fetchImpl, runWrangler });

  async function listWorkers(name) {
    const workers = [];
    let expectedTotalCount;
    let expectedTotalPages;
    for (let page = 1; ; page += 1) {
      const path = queryPath("/workers/scripts-search", [
        ["name", name],
        ["page", page],
        ["per_page", WORKER_PAGE_SIZE],
      ]);
      const parsed = parseWorkerPage(await api(path), page);
      if (expectedTotalPages === undefined) expectedTotalPages = parsed.totalPages;
      else if (parsed.totalPages !== expectedTotalPages) {
        throw new Error("Cloudflare Worker search total_pages changed during pagination");
      }
      if (name === undefined) {
        if (parsed.totalCount === undefined) {
          throw new Error("Cloudflare Worker search omitted total_count during discovery");
        }
        if (expectedTotalCount === undefined) expectedTotalCount = parsed.totalCount;
        else if (parsed.totalCount !== expectedTotalCount) {
          throw new Error("Cloudflare Worker search total_count changed during pagination");
        }
      }
      workers.push(...parsed.workers);
      if (parsed.totalPages === 0 || page === parsed.totalPages) break;
    }
    if (name === undefined && workers.length !== expectedTotalCount) {
      throw new Error("Cloudflare Worker search total_count did not match the complete result");
    }
    return workers;
  }

  async function listWorkerExact(name) {
    const matches = (await listWorkers(name)).filter((worker) => worker.script_name === name);
    if (matches.length > 1) throw new Error(`Found multiple Workers named ${name}`);
    return matches;
  }

  async function listR2Buckets() {
    const buckets = [];
    const seen = new Set();
    let cursor;
    do {
      const path = queryPath("/r2/buckets", [
        ["per_page", R2_PAGE_SIZE],
        ["cursor", cursor],
      ]);
      const response = await api(path);
      buckets.push(...parseR2Buckets(response.result));
      cursor = nextR2Cursor(response.resultInfo, seen);
    } while (cursor !== undefined);
    return buckets;
  }

  async function listD1Databases() {
    return parseD1Databases(await runWrangler(["d1", "list", "--json"]));
  }

  async function discover() {
    const candidates = new Set();
    const add = (kind, name) => {
      const pr = parsePreviewResourceName(kind, name);
      if (pr !== null) candidates.add(pr);
    };

    const workers = await listWorkers();
    const databases = await listD1Databases();
    const buckets = await listR2Buckets();
    for (const worker of workers) add("worker", worker.script_name);
    for (const database of databases) add("d1", database.name);
    for (const bucket of buckets) add("r2", bucket.name);

    if (candidates.size > MAX_MATRIX_CANDIDATES) {
      throw new Error(`Preview reaper found more than ${String(MAX_MATRIX_CANDIDATES)} candidates`);
    }
    return [...candidates].sort((left, right) => left - right);
  }

  async function readPull(prValue) {
    const pr = normalizePreviewPr(prValue);
    const repository = parseRepository(env);
    const result = await runGh([
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${repository}/pulls/${String(pr)}`,
    ]);
    return parsePullResponse(result, pr);
  }

  async function deleteWorkerVerified(name) {
    if (parsePreviewResourceName("worker", name) === null) {
      throw new Error(`Refusing to delete non-preview Worker ${String(name)}`);
    }
    const before = await listWorkerExact(name);
    if (before.length === 0) return "absent";

    let deletionError;
    try {
      await runWrangler(["delete", "--name", name, "--force"]);
    } catch (error) {
      deletionError = error;
    }

    const after = await listWorkerExact(name);
    if (after.length === 0) return deletionError === undefined ? "deleted" : "absent";
    if (deletionError !== undefined) {
      throw new Error(`Deleting Worker ${name} failed and it still exists`, {
        cause: deletionError,
      });
    }
    throw new Error(`Worker ${name} still exists after deletion`);
  }

  async function teardown(prValue) {
    const pr = normalizePreviewPr(prValue);
    const names = previewResourceNames(pr);
    const viewer = await deleteWorkerVerified(names.viewerWorker);
    const stash = await deleteWorkerVerified(names.stashWorker);
    const storageResult = await storage.teardown(pr);
    return { d1: storageResult.d1, pr, r2: storageResult.r2, stash, viewer };
  }

  return { deleteWorkerVerified, discover, readPull, teardown };
}

export async function runCli(
  argv,
  {
    createReaper = (options) => createPreviewReaper(options),
    env = process.env,
    writeLine = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const options = parseArguments(argv);
  if (options.help) {
    writeLine(usage());
    return undefined;
  }

  const reaper = createReaper({ env });
  let result;
  if (options.command === "discover") result = await reaper.discover();
  else if (options.command === "check-pr") result = await reaper.readPull(options.pr);
  else result = await reaper.teardown(options.pr);
  writeLine(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
