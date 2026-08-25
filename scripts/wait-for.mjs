#!/usr/bin/env node

const DEFAULT_HEALTH_URL = "http://localhost:8787/api/v1/health";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 500;
const EXPECTED_MARKER = "ZHS_HEALTH_OK";

function usage() {
  return [
    "Usage: node scripts/wait-for.mjs [--url URL] [--timeout-ms N] [--interval-ms N]",
    "Defaults to HEALTH_URL or http://localhost:8787/api/v1/health.",
  ].join("\n");
}

function positiveInteger(value, flag) {
  if (!value || !/^[1-9]\d*$/u.test(value)) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} is too large.`);
  return parsed;
}

function readOptions(argv) {
  let url = process.env.HEALTH_URL || DEFAULT_HEALTH_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let intervalMs = DEFAULT_INTERVAL_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--url" || argument === "--timeout-ms" || argument === "--interval-ms") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(usage());
      if (argument === "--url") url = value;
      if (argument === "--timeout-ms") timeoutMs = positiveInteger(value, argument);
      if (argument === "--interval-ms") intervalMs = positiveInteger(value, argument);
      index += 1;
      continue;
    }
    throw new Error(`${usage()}\nUnknown argument: ${argument}`);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid health URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Health URL must use http or https: ${url}`);
  }
  return { url: parsed.href, timeoutMs, intervalMs };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function healthProblem(url, requestTimeoutMs) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return `HTTP ${response.status}`;
    const value = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      value.marker !== EXPECTED_MARKER ||
      value.service !== "zudo-history-stash"
    ) {
      return `response did not contain ${EXPECTED_MARKER}`;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  const { url, timeoutMs, intervalMs } = readOptions(process.argv.slice(2));
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastProblem = "no response";

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    const problem = await healthProblem(url, Math.min(5_000, remainingMs));
    if (problem === null) {
      console.log(`Health ready after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${url}`);
      return;
    }
    lastProblem = problem;
    const pauseMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (pauseMs > 0) await delay(pauseMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}: ${lastProblem}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
