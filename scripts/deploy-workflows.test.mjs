import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATHS = {
  stash: "workers/stash/wrangler.toml",
  viewer: "workers/viewer/wrangler.toml",
};
const CHECKOUT = "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd";
const READY_IF = "needs.check-secrets.outputs.ready == 'true'";

function lines(source) {
  return source.replaceAll("\r\n", "\n").split("\n");
}

function block(source, key, indent) {
  const sourceLines = Array.isArray(source) ? source : lines(source);
  const prefix = `${" ".repeat(indent)}${key}:`;
  const start = sourceLines.findIndex((line) => line.startsWith(prefix));
  assert.notEqual(start, -1, `Missing ${key} block`);
  const end = sourceLines.findIndex(
    (line, index) => index > start && line.trim() && line.search(/\S/u) <= indent,
  );
  return sourceLines.slice(start, end === -1 ? sourceLines.length : end).join("\n");
}

function stepForRun(job, command) {
  const jobLines = lines(job);
  const run = `        run: ${command}`;
  const runIndex = jobLines.findIndex((line) => line === run);
  assert.notEqual(runIndex, -1, `Missing ${command} step`);
  const start = jobLines.findLastIndex(
    (line, index) => index < runIndex && line.startsWith("      - name:"),
  );
  const end = jobLines.findIndex(
    (line, index) => index > runIndex && line.startsWith("      - name:"),
  );
  return jobLines.slice(start, end === -1 ? jobLines.length : end).join("\n");
}

function validateDeployWorkflows({ stash, viewer }) {
  for (const [name, source] of Object.entries({ stash, viewer })) {
    const config = CONFIG_PATHS[name];
    const checkJob = block(block(source, "jobs", 0), "check-secrets", 2);
    const gate = stepForRun(checkJob, "bash scripts/deploy-gate.sh");
    const checkoutIndex = checkJob.indexOf(`uses: ${CHECKOUT}`);
    const gateIndex = checkJob.indexOf("run: bash scripts/deploy-gate.sh");

    assert.ok(checkoutIndex >= 0 && checkoutIndex < gateIndex, `${name} checks out before gating`);
    assert.match(gate, /id: check\n/u);
    assert.match(gate, /PRODUCTION_DEPLOY_DISABLED: \$\{\{ vars\.PRODUCTION_DEPLOY_DISABLED \}\}/u);
    assert.match(gate, new RegExp(`DEPLOY_TARGET: ${name} Worker`, "u"));
    assert.match(gate, new RegExp(`DEPLOY_WRANGLER_CONFIG: ${config}`, "u"));
    if (name === "stash")
      assert.match(gate, /DEPLOY_REQUIRED_KEY_PATTERN: database_id\[\[:space:\]\]\*=\n/u);
    assert.doesNotMatch(source, /grep -Eq 'REPLACE_/u);

    const jobs = block(source, "jobs", 0);
    for (const jobName of ["check-secrets", ...jobs.matchAll(/^  ([\w-]+):/gmu)].map((job) =>
      typeof job === "string" ? job : job[1],
    )) {
      const job = block(jobs, jobName, 2);
      const gated = job.includes(`if: ${READY_IF}`);
      if (jobName !== "check-secrets" && job.includes("secrets.CLOUDFLARE_API_TOKEN")) {
        assert.ok(gated, `${name}/${jobName} must carry the deploy gate`);
      }
      if (/wrangler (?:deploy|d1 migrations apply)/u.test(job)) {
        assert.ok(gated, `${name}/${jobName} Wrangler commands must carry the deploy gate`);
      }
    }
  }
}

async function sources() {
  const [stash, viewer] = await Promise.all([
    readFile(resolve(ROOT, ".github/workflows/deploy-stash.yml"), "utf8"),
    readFile(resolve(ROOT, ".github/workflows/deploy-viewer.yml"), "utf8"),
  ]);
  await Promise.all(
    Object.values(CONFIG_PATHS).map((path) => readFile(resolve(ROOT, path), "utf8")),
  );
  return { stash, viewer };
}

describe("deployment workflows", () => {
  it("use the shared production deploy gate", async () => {
    validateDeployWorkflows(await sources());
  });

  it("fails non-vacuously when the stash deploy job loses its gate", async () => {
    const original = await sources();
    const mutatedStash = original.stash.replace(
      "    if: needs.check-secrets.outputs.ready == 'true'\n    runs-on: ubuntu-latest\n    timeout-minutes: 15",
      "    runs-on: ubuntu-latest\n    timeout-minutes: 15",
    );
    assert.notEqual(mutatedStash, original.stash);
    assert.throws(() => validateDeployWorkflows({ ...original, stash: mutatedStash }));
  });
});
