#!/usr/bin/env node

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const PROVISIONING_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const REQUEST_TIMEOUT_MS = 15_000;

function readTarget() {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex === -1 ? "" : process.argv[targetIndex + 1];
  if (target !== "stash" && target !== "viewer") {
    throw new Error("Usage: node scripts/smoke.mjs --target stash|viewer");
  }
  return target;
}

function baseUrlFor(target) {
  const value =
    process.env.SMOKE_BASE_URL ||
    (target === "stash" ? process.env.STASH_BASE_URL : process.env.VIEWER_BASE_URL);
  return value ? value.replace(/\/+$/, "") : "";
}

function errorCodes(error, seen = new Set()) {
  if (!error || seen.has(error)) return [];
  seen.add(error);
  const codes = [];
  if (typeof error.code === "string") codes.push(error.code);
  if (error.name === "TimeoutError") codes.push("ETIMEDOUT");
  if (error.cause) codes.push(...errorCodes(error.cause, seen));
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) codes.push(...errorCodes(nested, seen));
  }
  return codes;
}

function isProvisioningError(error) {
  return errorCodes(error).some((code) => PROVISIONING_ERROR_CODES.has(code));
}

function skipOrFail(message) {
  if (process.env.SMOKE_REQUIRE_LIVE === "1") {
    throw new Error(`${message} (SMOKE_REQUIRE_LIVE=1)`);
  }
  console.log(`::notice::Smoke skipped: ${message}`);
}

async function jsonGet(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

function navigationGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-site": "none",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeoutError = new Error("smoke request timed out");
      timeoutError.code = "ETIMEDOUT";
      request.destroy(timeoutError);
    });
    request.on("error", reject);
    request.end();
  });
}

async function smokeStash(url) {
  try {
    const result = await jsonGet(`${url}/v1/health`);
    if (result.status !== 200) {
      throw new Error(`stash health returned HTTP ${result.status}`);
    }
    let body;
    try {
      body = JSON.parse(result.body);
    } catch {
      throw new Error("stash health did not return JSON");
    }
    if (body.marker !== "ZHS_HEALTH_OK") {
      throw new Error("stash health JSON is missing marker ZHS_HEALTH_OK");
    }
    console.log("stash smoke passed: /v1/health");
  } catch (error) {
    if (isProvisioningError(error)) {
      skipOrFail(
        `stash is not provisioned (${errorCodes(error).join(", ") || "connection error"})`,
      );
      return;
    }
    throw error;
  }
}

async function smokeViewer(url) {
  try {
    const result = await navigationGet(`${url}/login`);
    if (result.status !== 200) {
      throw new Error(`viewer navigation returned HTTP ${result.status}`);
    }
    if (!/<title\b[^>]*>[\s\S]*?<\/title>/i.test(result.body)) {
      throw new Error("viewer navigation returned HTML without a <title>");
    }
    console.log("viewer smoke passed: navigation /login");
  } catch (error) {
    if (isProvisioningError(error)) {
      skipOrFail(
        `viewer is not provisioned (${errorCodes(error).join(", ") || "connection error"})`,
      );
      return;
    }
    throw error;
  }
}

async function main() {
  const target = readTarget();
  const url = baseUrlFor(target);
  if (!url) {
    skipOrFail(`${target} smoke URL is not configured (set SMOKE_BASE_URL)`);
    return;
  }
  console.log(`Smoke target: ${target} ${url}`);
  if (target === "stash") await smokeStash(url);
  else await smokeViewer(url);
}

try {
  await main();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
