import { runConformance } from "../dist/testing/index.js";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseSummary(response) {
  const body = await response.text();
  return `status ${response.status}${body === "" ? "" : `: ${body.slice(0, 500)}`}`;
}

async function exhaustLocalWriteLimit(baseUrl, target) {
  if (target.capability !== "write" || target.routeId !== "putFile") {
    throw new Error(
      `live limiter adapter only supports the write/putFile probe, received ${target.capability}/${target.routeId}`,
    );
  }

  const stash = encodeURIComponent(target.stash);
  const probeUrl = `${baseUrl}/v1/stashes/${stash}/files/docs/conformance-rate-limit-probe.txt`;
  for (let attempt = 1; attempt <= 80; attempt += 1) {
    const response = await fetch(probeUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
      },
      // The limiter runs before body validation. This cannot persist even if the binding fails open.
      body: "{}",
    });
    if (response.status === 429) {
      if (response.headers.get("Retry-After") !== "60") {
        throw new Error(
          `rate-limit probe received 429 without Retry-After: 60 (attempt ${attempt})`,
        );
      }
      return;
    }
    if (response.status !== 400) {
      throw new Error(
        `rate-limit probe expected 400 while charging ${target.key}, received ${await responseSummary(response)}`,
      );
    }
  }
  throw new Error(
    `rate-limit probe never received 429 for ${target.capability}/${target.key} after 80 attempts`,
  );
}

async function main() {
  const baseUrl = requiredEnvironment("API_BASE_URL").replace(/\/+$/, "");
  const adminToken = requiredEnvironment("STASH_ADMIN_TOKEN");
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("API_BASE_URL must use http or https");
  }

  console.log(`[conformance-live] running against ${baseUrl}`);
  const report = await runConformance(fetch, baseUrl, {
    adminToken,
    ...(process.env.CONFORMANCE_STASH_NAME
      ? { stashName: process.env.CONFORMANCE_STASH_NAME }
      : {}),
    async advanceTime(milliseconds) {
      await sleep(milliseconds + 150);
    },
    configureRateLimit(target) {
      return exhaustLocalWriteLimit(baseUrl, target);
    },
  });
  console.log(
    `[conformance-live] passed ${report.steps} steps for ${report.stash} (${report.exercisedRouteIds.length} route IDs)`,
  );
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[conformance-live] failed\n${detail}`);
  process.exitCode = 1;
}
