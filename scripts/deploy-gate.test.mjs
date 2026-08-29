import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const SCRIPT = resolve(import.meta.dirname, "deploy-gate.sh");
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function makeConfig(contents) {
  const directory = await mkdtemp(resolve(tmpdir(), "zhs-deploy-gate-config-"));
  scratch.push(directory);
  const path = resolve(directory, "wrangler.toml");
  await writeFile(path, contents);
  return path;
}

async function runGate(vars = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "zhs-deploy-gate-"));
  scratch.push(directory);
  const output = resolve(directory, "output");
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: output };
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) env[key] = value;
  }
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bash", [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  return {
    ...result,
    output: await readFile(output, "utf8").catch(() => ""),
  };
}

const VALID_TARGET = "viewer Worker";
const VALID_CREDENTIALS = {
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
};

function withValidInputs(config, overrides = {}) {
  return {
    DEPLOY_TARGET: VALID_TARGET,
    DEPLOY_WRANGLER_CONFIG: config,
    ...VALID_CREDENTIALS,
    ...overrides,
  };
}

describe("deploy credential gate", () => {
  it("lets the kill switch win before validating inputs or exposing credentials", async () => {
    const token = "sentinel-cloudflare-token";
    const account = "sentinel-cloudflare-account";
    const result = await runGate({
      PRODUCTION_DEPLOY_DISABLED: "true",
      DEPLOY_TARGET: `${token}-target`,
      DEPLOY_WRANGLER_CONFIG: `${account}-config`,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
    });

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=false\n");
    assert.equal(
      result.stdout,
      "::notice::Production deploys are disabled by repository variable; deployment is skipped.\n",
    );
    assert.equal(result.stderr, "");
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(account), false);
  });

  for (const fixture of [
    { name: "target", vars: { DEPLOY_WRANGLER_CONFIG: "/tmp/deploy-gate-config.toml" } },
    { name: "config", vars: { DEPLOY_TARGET: VALID_TARGET } },
  ]) {
    it(`fails closed when the ${fixture.name} is missing`, async () => {
      const result = await runGate({ ...VALID_CREDENTIALS, ...fixture.vars });

      assert.equal(result.code, 1);
      assert.equal(result.output, "ready=false\n");
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /DEPLOY_TARGET and DEPLOY_WRANGLER_CONFIG are required\./u);
    });
  }

  for (const fixture of [
    { name: "neither credential", vars: {} },
    { name: "only the API token", vars: { CLOUDFLARE_API_TOKEN: "token" } },
    { name: "only the account id", vars: { CLOUDFLARE_ACCOUNT_ID: "account" } },
  ]) {
    it(`skips with ${fixture.name}`, async () => {
      const config = await makeConfig('pattern = "viewer.history-stash.com"\n');
      const result = await runGate(
        withValidInputs(config, {
          CLOUDFLARE_API_TOKEN: undefined,
          CLOUDFLARE_ACCOUNT_ID: undefined,
          ...fixture.vars,
        }),
      );

      assert.equal(result.code, 0);
      assert.equal(result.output, "ready=false\n");
      assert.match(result.stdout, /Cloudflare secrets are not configured/u);
      assert.equal(result.stderr, "");
    });
  }

  it("skips when the Wrangler config does not exist", async () => {
    const config = resolve(tmpdir(), "zhs-deploy-gate-does-not-exist", "wrangler.toml");
    const result = await runGate(withValidInputs(config));

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=false\n");
    assert.match(result.stdout, new RegExp(`${config} is missing`, "u"));
    assert.equal(result.stderr, "");
  });

  it("skips when the required binding pattern is unmatched", async () => {
    const config = await makeConfig('pattern = "viewer.history-stash.com"\n');
    const result = await runGate(
      withValidInputs(config, { DEPLOY_REQUIRED_KEY_PATTERN: "database_id[[:space:]]*=" }),
    );

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=false\n");
    assert.match(result.stdout, /has no provisioned binding/u);
    assert.equal(result.stderr, "");
  });

  it("treats an empty required binding pattern as absent", async () => {
    const config = await makeConfig('pattern = "viewer.history-stash.com"\n');
    const result = await runGate(withValidInputs(config, { DEPLOY_REQUIRED_KEY_PATTERN: "" }));

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=true\n");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  for (const fixture of [
    {
      name: "REPLACE_ME",
      contents: 'pattern = "viewer.history-stash.com"\nvalue = "REPLACE_ME"\n',
    },
    {
      name: "double-underscore placeholder",
      contents: 'pattern = "viewer.history-stash.com"\nvalue = "__DOMAIN__"\n',
    },
  ]) {
    it(`skips ${fixture.name} values`, async () => {
      const config = await makeConfig(fixture.contents);
      const result = await runGate(withValidInputs(config));

      assert.equal(result.code, 0);
      assert.equal(result.output, "ready=false\n");
      assert.match(result.stdout, /still contains placeholder values/u);
      assert.equal(result.stderr, "");
    });
  }

  it("skips a pattern line ending in an unownable example hostname", async () => {
    const config = await makeConfig('pattern = "history-stash.example.com"\n');
    const result = await runGate(withValidInputs(config));

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=false\n");
    assert.match(result.stdout, /routes an unownable placeholder hostname/u);
    assert.equal(result.stderr, "");
  });

  it("enables a real hostname with a provisioned-looking database binding", async () => {
    const config = await makeConfig(
      [
        'pattern = "viewer.history-stash.com"',
        'database_id = "0123456789abcdef0123456789abcdef"',
        "",
      ].join("\n"),
    );
    const result = await runGate(
      withValidInputs(config, { DEPLOY_REQUIRED_KEY_PATTERN: "database_id[[:space:]]*=" }),
    );

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=true\n");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
