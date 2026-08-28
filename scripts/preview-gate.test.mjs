import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(import.meta.dirname, "preview-gate.sh");
const WORKFLOW = resolve(REPOSITORY_ROOT, ".github/workflows/preview.yml");
const scratch = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function runGate({ fork, token, account } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "zhs-preview-gate-"));
  scratch.push(directory);
  const output = resolve(directory, "output");
  const env = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: output,
    ...(fork === undefined ? {} : { PREVIEW_IS_FORK: fork }),
    ...(token === undefined ? {} : { CLOUDFLARE_API_TOKEN: token }),
    ...(account === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: account }),
  };
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

describe("preview credential gate", () => {
  it("skips forks before consulting even populated credential fixtures", async () => {
    const token = "sentinel-cloudflare-token";
    const account = "sentinel-cloudflare-account";
    const result = await runGate({ fork: "true", token, account });

    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=false\n");
    assert.match(result.stdout, /disabled for fork pull requests/u);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(account), false);
  });

  for (const fixture of [
    { name: "neither credential", token: undefined, account: undefined },
    { name: "only the API token", token: "token", account: undefined },
    { name: "only the account id", token: undefined, account: "account" },
  ]) {
    it(`skips a same-repository PR with ${fixture.name}`, async () => {
      const result = await runGate({ fork: "false", ...fixture });
      assert.equal(result.code, 0);
      assert.equal(result.output, "ready=false\n");
      assert.match(result.stdout, /both Cloudflare credentials/u);
    });
  }

  it("enables a same-repository PR only when both credentials are present", async () => {
    const result = await runGate({ fork: "false", token: "token", account: "account" });
    assert.equal(result.code, 0);
    assert.equal(result.output, "ready=true\n");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  for (const fork of [undefined, "False", "1", ""]) {
    it(`fails closed for malformed fork state ${JSON.stringify(fork)}`, async () => {
      const result = await runGate({ fork, token: "token", account: "account" });
      assert.equal(result.code, 1);
      assert.equal(result.output, "ready=false\n");
      assert.match(result.stderr, /must be exactly true or false/u);
    });
  }
});

describe("preview workflow security boundary", () => {
  it("uses the event fork decision before the gate probe and step-local deploy credentials", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    assert.equal(source.includes("pull_request_target"), false);
    assert.match(
      source,
      /group: preview-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr \|\| github\.run_id \}\}/u,
    );
    assert.match(source, /cancel-in-progress: true/u);

    const secretLines = source
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => line.includes("secrets."));
    assert.equal(secretLines.length, 10);
    assert.deepEqual(
      [...new Set(secretLines.map(({ line }) => line.trim()))],
      [
        "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
        "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      ],
    );

    const step = (name) =>
      source.match(new RegExp(`- name: ${name}\\n[\\s\\S]*?(?=\\n\\s{6}- name:|$)`, "u"))?.[0];
    const cloudflareSteps = [
      "Check preview credentials",
      "Ensure resources and resolve URLs",
      "Apply D1 migrations",
      "Deploy Stash with first-deploy admin secret",
      "Deploy Viewer",
    ];
    for (const name of cloudflareSteps) {
      const block = step(name);
      assert.ok(block, `${name} step is present`);
      assert.match(block, /env:\n/u);
      assert.match(block, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
      assert.match(block, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/u);
    }

    const credentialStep = source.match(
      /- name: Check preview credentials[\s\S]*?(?=\n\s{6}- name:|\n\s{4}outputs:)/u,
    )?.[0];
    assert.ok(credentialStep, "credential step is present");
    assert.match(credentialStep, /if: github\.event\.pull_request\.head\.repo\.fork == false/u);
    assert.match(credentialStep, /env:\n\s+CLOUDFLARE_API_TOKEN:/u);
    assert.match(credentialStep, /PREVIEW_IS_FORK: "false"/u);

    const prefix = source.slice(0, source.indexOf(credentialStep));
    assert.equal(prefix.includes("secrets."), false);
    assert.match(
      source,
      /deploy:\n[\s\S]*?needs: gate\n\s+if: needs\.gate\.outputs\.ready == 'true'/u,
    );
    const gateJob = source.slice(source.indexOf("  gate:\n"), source.indexOf("\n  deploy:\n"));
    assert.match(gateJob, /outputs:\n\s+ready: \$\{\{ steps\.credentials\.outputs\.ready/u);
    assert.equal(gateJob.includes("outputs.token"), false);
    assert.equal(gateJob.includes("outputs.account"), false);
    assert.match(gateJob, /permissions:\n\s+contents: read/u);
  });

  it("pins every action to the exact CI SHA", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    const uses = [...source.matchAll(/^\s+uses: (\S+)(?:\s+#.*)?$/gmu)].map((match) => match[1]);
    const allowed = new Set([
      "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd",
      "pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320",
      "actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444",
      "actions/cache@5a3ec84eff668545956fd18022155c47e93e2684",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ]);
    assert.equal(uses.length, 6);
    assert.deepEqual(
      uses.filter((entry) => !allowed.has(entry)),
      [],
    );
    assert.equal(uses.filter((entry) => entry.startsWith("actions/checkout@")).length, 2);
  });

  it("locks checkout identity, structured JSON seams, and private secret cleanup", async () => {
    const source = await readFile(WORKFLOW, "utf8");
    assert.equal((source.match(/persist-credentials: false/gu) ?? []).length, 2);
    assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
    assert.match(source, /resources_json="\$\(node scripts\/preview-resources\.mjs ensure/u);
    assert.match(source, /urls_json="\$\(node scripts\/preview-resources\.mjs urls/u);
    assert.match(source, /config_json="\$\(node scripts\/preview-config\.mjs/u);
    assert.equal(source.includes("$(pnpm preview:"), false);
    assert.match(source, /EXPECTED_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
    assert.match(source, /\[\[ "\$deployed_sha" == "\$EXPECTED_SHA" \]\]/u);

    assert.match(source, /umask 077[\s\S]*?chmod 600 "\$secrets_file"/u);
    assert.match(source, /trap 'rm -f -- "\$secrets_file"' EXIT INT TERM/u);
    const cleanupPosition = source.indexOf("- name: Remove private preview state");
    const artifactPosition = source.indexOf("- name: Upload non-secret deploy logs");
    assert.ok(cleanupPosition > 0 && artifactPosition > cleanupPosition);
    assert.equal(source.includes("stash-secrets.json"), false);
  });
});
