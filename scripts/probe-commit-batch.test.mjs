import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPOSITORY_ROOT, "workers/stash/scripts/probe-commit-batch.mjs");

async function runProbe(environment) {
  const childEnvironment = {
    PATH: process.env.PATH,
    ...environment,
  };
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPOSITORY_ROOT,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stderr, stdout }));
  });
}

describe("commit-batch probe validation", () => {
  for (const { name, environment, expectedError } of [
    {
      name: "an unsupported query limit of 100",
      environment: { COMMIT_BATCH_PROBE_QUERY_LIMIT: "100" },
      expectedError: /COMMIT_BATCH_PROBE_QUERY_LIMIT must be 50, 1000, or omitted/u,
    },
    {
      name: "an unsupported query limit of 49",
      environment: { COMMIT_BATCH_PROBE_QUERY_LIMIT: "49" },
      expectedError: /COMMIT_BATCH_PROBE_QUERY_LIMIT must be 50, 1000, or omitted/u,
    },
    {
      name: "a privileged port",
      environment: { COMMIT_BATCH_PROBE_PORT: "80" },
      expectedError: /COMMIT_BATCH_PROBE_PORT must be a safe, non-privileged TCP port/u,
    },
    {
      name: "a non-numeric port",
      environment: { COMMIT_BATCH_PROBE_PORT: "notanumber" },
      expectedError: /COMMIT_BATCH_PROBE_PORT must be a safe, non-privileged TCP port/u,
    },
    {
      name: "remote mode without Cloudflare credentials",
      environment: { COMMIT_BATCH_PROBE_REMOTE: "1" },
      expectedError: /Remote mode requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/u,
    },
  ]) {
    it(`rejects ${name} before starting a probe Worker`, async () => {
      const result = await runProbe(environment);

      assert.notEqual(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, expectedError);
    });
  }
});
