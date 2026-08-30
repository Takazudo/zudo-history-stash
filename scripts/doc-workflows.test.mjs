import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIRECTORY = resolve(ROOT, ".github/workflows");
const WORKFLOW_PATHS = {
  checks: resolve(WORKFLOW_DIRECTORY, "doc-checks.yml"),
  deploy: resolve(WORKFLOW_DIRECTORY, "doc-deploy.yml"),
  preview: resolve(WORKFLOW_DIRECTORY, "doc-preview.yml"),
};
const COMMON_PATHS = [
  "doc/**",
  "docs/openapi.json",
  "packages/**",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".mdx-formatter.json",
  ".mdx-formatter-ignore",
  "lefthook.yml",
];
const INTERNAL_AGGREGATE_COMMANDS = [
  "build:libs",
  "format:check",
  "format:md:check",
  "check:template-drift",
  "check:pin-parity",
  "check:wrangler-pin",
  "check:contract",
  "check:versions",
  "check:examples",
  "check:locale-parity",
  "zfb check",
  "zfb build",
  "check:html",
  "check:links",
];
const HISTORY_COMMAND = [
  "cd doc && pnpm exec doc-history-generate",
  "--content-dir src/content/docs",
  "--locale ja:src/content/docs-ja",
  "--out-dir dist/doc-history",
  "--max-entries 50",
].join(" ");
const CLOUDFLARE_SECRET_EXPRESSIONS = {
  CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
};
const GITHUB_TOKEN_EXPRESSION = "${{ github.token }}";
const GITHUB_CONTEXT_ALLOWLIST = {
  checks: {
    explicit: [
      "${{ github.workflow }}",
      "${{ github.ref }}",
      "${{ github.event_name == 'pull_request' }}",
    ],
    implicit: [],
  },
  deploy: { explicit: [], implicit: [] },
  preview: {
    explicit: [
      "${{ github.event.pull_request.number }}",
      "${{ github.event.pull_request.number }}",
      "${{ github.event.pull_request.number }}",
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.event.pull_request.head.sha }}",
      "${{ github.repository }}",
      "${{ github.token }}",
    ],
    implicit: [
      "github.event.pull_request.head.repo.full_name",
      "github.event.pull_request.head.repo.full_name",
      "github.repository",
      "github.repository",
    ],
  },
};
const CREDENTIAL_PROBE_NOTICES = {
  "Check preview credentials":
    "::notice::Cloudflare credentials are incomplete; documentation preview skipped.",
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lines(value) {
  return value.replaceAll("\r\n", "\n").split("\n");
}

function indentation(line) {
  return line.match(/^ */u)[0].length;
}

function blockForKey(value, key, indent) {
  const sourceLines = Array.isArray(value) ? value : lines(value);
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:(?:\\s|$)`, "u");
  const start = sourceLines.findIndex((line) => pattern.test(line));
  assert.notEqual(start, -1, `Missing ${key} block at indentation ${indent}`);
  let end = sourceLines.length;
  for (let index = start + 1; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (line.trim() && indentation(line) <= indent) {
      end = index;
      break;
    }
  }
  return sourceLines.slice(start, end);
}

function keysAtIndent(value, indent) {
  const pattern = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):(?:\\s|$)`, "u");
  return lines(Array.isArray(value) ? value.join("\n") : value)
    .map((line) => line.match(pattern)?.[1])
    .filter(Boolean);
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function directScalar(value, key, indent) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "u");
  const match = lines(Array.isArray(value) ? value.join("\n") : value)
    .map((line) => line.match(pattern))
    .find(Boolean);
  assert.ok(match, `Missing scalar ${key} at indentation ${indent}`);
  return unquote(match[1]);
}

function optionalDirectScalar(value, key, indent) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "u");
  const match = lines(Array.isArray(value) ? value.join("\n") : value)
    .map((line) => line.match(pattern))
    .find(Boolean);
  return match ? unquote(match[1]) : undefined;
}

function hasDirectKey(value, key, indent) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:(?:\\s|$)`, "mu");
  return pattern.test(Array.isArray(value) ? value.join("\n") : value);
}

function listProperty(value, key, indent) {
  const sourceLines = Array.isArray(value) ? value : lines(value);
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "u");
  const index = sourceLines.findIndex((line) => pattern.test(line));
  assert.notEqual(index, -1, `Missing list ${key} at indentation ${indent}`);
  const inline = sourceLines[index].match(pattern)[1];
  if (inline) {
    assert.match(inline, /^\[.*\]$/u, `${key} must be an inline list or sequence`);
    const body = inline.slice(1, -1).trim();
    return body ? body.split(",").map((item) => unquote(item)) : [];
  }
  const result = [];
  for (let cursor = index + 1; cursor < sourceLines.length; cursor += 1) {
    const line = sourceLines[cursor];
    if (line.trim() && indentation(line) <= indent) break;
    const item = line.match(new RegExp(`^ {${indent + 2}}-\\s+(.+?)\\s*$`, "u"));
    if (item) result.push(unquote(item[1]));
  }
  return result;
}

function directMap(value, key, indent) {
  const block = blockForKey(value, key, indent);
  const result = {};
  const pattern = new RegExp(`^ {${indent + 2}}([A-Za-z0-9_-]+):\\s*(.*?)\\s*$`, "u");
  for (const line of block.slice(1)) {
    const match = line.match(pattern);
    if (match) result[match[1]] = unquote(match[2]);
  }
  return result;
}

function jobBlocks(source) {
  const jobs = blockForKey(source, "jobs", 0);
  const names = keysAtIndent(jobs, 2);
  return Object.fromEntries(names.map((name) => [name, blockForKey(jobs, name, 2)]));
}

function parseSteps(job) {
  const jobLines = Array.isArray(job) ? job : lines(job);
  const steps = blockForKey(jobLines, "steps", 4);
  const starts = [];
  for (let index = 1; index < steps.length; index += 1) {
    if (/^ {6}-\s+/u.test(steps[index])) starts.push(index);
  }
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? steps.length;
    const block = steps.slice(start, end);
    const name = block[0].match(/^ {6}- name:\s*(.+?)\s*$/u)?.[1];
    assert.ok(name, "Every documentation workflow step must have a name");
    return { block, name: unquote(name) };
  });
}

function stepScalar(step, key) {
  return optionalDirectScalar(step.block, key, 8);
}

function stepMap(step, key) {
  if (!step.block.some((line) => new RegExp(`^ {8}${escapeRegExp(key)}:`, "u").test(line))) {
    return {};
  }
  return directMap(step.block, key, 8);
}

function stepRun(step) {
  const sourceLines = step.block;
  const index = sourceLines.findIndex((line) => /^ {8}run:/u.test(line));
  if (index === -1) return undefined;
  const raw = sourceLines[index].match(/^ {8}run:\s*(.*?)\s*$/u)[1];
  if (raw && !/^[>|]/u.test(raw)) return unquote(raw);
  const body = [];
  for (let cursor = index + 1; cursor < sourceLines.length; cursor += 1) {
    if (sourceLines[cursor].trim() && indentation(sourceLines[cursor]) <= 8) break;
    body.push(sourceLines[cursor].slice(10));
  }
  return body.join("\n").trim();
}

function normalizedRun(step) {
  return stepRun(step)?.replace(/\s+/gu, " ").trim();
}

function eventBlock(source, event) {
  return blockForKey(blockForKey(source, "on", 0), event, 2);
}

function expectedPaths(workflowName) {
  return [...COMMON_PATHS, `.github/workflows/${workflowName}.yml`];
}

function deriveCiPins(ci) {
  const actions = ["actions/checkout", "pnpm/action-setup", "actions/setup-node"];
  return Object.fromEntries(
    actions.map((action) => {
      const refs = [
        ...ci.matchAll(new RegExp(`${escapeRegExp(action)}@([a-f0-9]{40})(?:\\s|#|$)`, "gu")),
      ].map((match) => match[1]);
      assert.ok(refs.length > 0, `CI does not pin ${action}`);
      assert.equal(new Set(refs).size, 1, `CI uses multiple refs for ${action}`);
      return [action, `${action}@${refs[0]}`];
    }),
  );
}

function assertExactEvents(source, expected) {
  assert.deepEqual(keysAtIndent(blockForKey(source, "on", 0), 2), Object.keys(expected));
  for (const [event, contract] of Object.entries(expected)) {
    const block = eventBlock(source, event);
    if (contract.branches) assert.deepEqual(listProperty(block, "branches", 4), contract.branches);
    if (contract.types) assert.deepEqual(listProperty(block, "types", 4), contract.types);
    if (contract.paths) assert.deepEqual(listProperty(block, "paths", 4), contract.paths);
  }
}

function assertPermissions(block, expected, indent) {
  assert.deepEqual(directMap(block, "permissions", indent), expected);
}

function assertCommonSourceSafety(source, { allowedVarsExpressions = [] } = {}) {
  const sourceWithoutAllowedVars = allowedVarsExpressions.reduce(
    (remaining, expression) => remaining.replaceAll(expression, ""),
    source,
  );
  assert.doesNotMatch(source, /pull_request_target/u);
  assert.doesNotMatch(sourceWithoutAllowedVars, /\bvars(?:\.|\s*\[)/u);
  assert.doesNotMatch(source, /\bsecrets\s*\[/u);
  assert.doesNotMatch(source, /\bgithub\s*\[\s*["']token["']\s*\]/u);
  assert.doesNotMatch(source, /cloudflare\/wrangler-action/u);
  assert.doesNotMatch(source, /actions\/github-script/u);
  assert.doesNotMatch(source, /actions\/(?:upload|download)-artifact/u);
  assert.equal(hasDirectKey(source, "env", 0), false, "Workflow-level env is forbidden");
  for (const [name, job] of Object.entries(jobBlocks(source))) {
    assert.equal(hasDirectKey(job, "env", 4), false, `${name} job-level env is forbidden`);
  }
  assertPermissions(source, { contents: "read" }, 0);
}

function assertCommonBuildJob(job, pins, { previewHead = false, permissions } = {}) {
  assert.equal(directScalar(job, "runs-on", 4), "ubuntu-latest");
  const timeout = Number(directScalar(job, "timeout-minutes", 4));
  assert.ok(
    Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 60,
    "Job timeout is bounded",
  );
  assert.equal(optionalDirectScalar(job, "container", 4), undefined);
  assert.equal(optionalDirectScalar(job, "services", 4), undefined);
  assertPermissions(job, permissions ?? { contents: "read" }, 4);

  const steps = parseSteps(job);
  const uses = steps.filter((step) => stepScalar(step, "uses"));
  assert.equal(uses.length, 3, "Build job has only checkout/pnpm/Node actions");
  for (const step of uses) {
    const action = stepScalar(step, "uses").split("@")[0];
    assert.equal(stepScalar(step, "uses").replace(/\s+#.*$/u, ""), pins[action]);
  }

  const checkout = steps.find((step) => stepScalar(step, "uses")?.startsWith("actions/checkout@"));
  assert.ok(checkout, "Missing checkout step");
  assert.deepEqual(stepMap(checkout, "with"), {
    ...(previewHead ? { ref: "${{ github.event.pull_request.head.sha }}" } : {}),
    "fetch-depth": "0",
    "persist-credentials": "false",
  });
  const pnpm = steps.find((step) => stepScalar(step, "uses")?.startsWith("pnpm/action-setup@"));
  assert.deepEqual(stepMap(pnpm, "with"), { version: "10.32.0" });
  const node = steps.find((step) => stepScalar(step, "uses")?.startsWith("actions/setup-node@"));
  assert.deepEqual(stepMap(node, "with"), { "node-version": "22.13.0" });
  assert.equal(
    steps.filter((step) => normalizedRun(step) === "pnpm install --frozen-lockfile").length,
    1,
    "Build job must install once with the frozen lockfile",
  );
  assert.equal(
    steps.filter((step) => normalizedRun(step) === "pnpm b4push:doc").length,
    1,
    "Build job must call the documentation aggregate exactly once",
  );
  for (const step of steps) {
    const run = normalizedRun(step) ?? "";
    for (const command of INTERNAL_AGGREGATE_COMMANDS) {
      assert.equal(
        run.includes(command),
        false,
        `Workflow duplicates aggregate command ${command}`,
      );
    }
  }
  return steps;
}

function secretReferences(value) {
  return [...value.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1]);
}

function secretContextOccurrences(value) {
  return [...value.matchAll(/\bsecrets\b/gu)];
}

function githubTokenOccurrences(value) {
  return [...value.matchAll(/\bgithub\.token\b/giu)];
}

function actionExpressions(value) {
  return [...value.matchAll(/\$\{\{[^\r\n]*?\}\}/gu)].map((match) => match[0]);
}

function githubContextReferences(value) {
  return [...value.matchAll(/(?<!\.)\bgithub(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?![A-Za-z0-9_])/giu)].map(
    (match) => match[0],
  );
}

function assertGithubContextAllowlist(source, workflowName) {
  const expected = GITHUB_CONTEXT_ALLOWLIST[workflowName];
  assert.ok(expected, `Missing GitHub context allowlist for ${workflowName}`);
  const explicit = actionExpressions(source)
    .filter((expression) => githubContextReferences(expression).length > 0)
    .toSorted();
  assert.deepEqual(
    explicit,
    expected.explicit.toSorted(),
    `${workflowName} must use only exact approved GitHub context expressions`,
  );
  const withoutExplicitExpressions = source.replace(/\$\{\{[^\r\n]*?\}\}/gu, "");
  assert.deepEqual(
    githubContextReferences(withoutExplicitExpressions).toSorted(),
    expected.implicit.toSorted(),
    `${workflowName} must not expose the whole or an unapproved GitHub context`,
  );
}

function assertSecretAllowlist(source, allowedByJob) {
  const jobs = jobBlocks(source);
  const referencesInsideSteps = [];
  let contextsInsideSteps = 0;
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of parseSteps(job)) {
      const expected = (allowedByJob[jobName]?.[step.name] ?? []).toSorted();
      const stepSource = step.block.join("\n");
      const env = stepMap(step, "env");
      const allStepReferences = secretReferences(stepSource).toSorted();
      const envReferences = Object.values(env)
        .flatMap((value) => secretReferences(value))
        .toSorted();
      assert.deepEqual(allStepReferences, expected, `${jobName}/${step.name} secret allowlist`);
      assert.deepEqual(envReferences, expected, `${jobName}/${step.name} secrets must be step env`);
      assert.equal(
        secretContextOccurrences(stepSource).length,
        expected.length,
        `${jobName}/${step.name} must not expose the whole secrets context`,
      );
      for (const secret of expected) {
        assert.ok(Object.hasOwn(CLOUDFLARE_SECRET_EXPRESSIONS, secret));
        assert.equal(
          env[secret],
          CLOUDFLARE_SECRET_EXPRESSIONS[secret],
          `${jobName}/${step.name}/${secret} must use its exact approved expression`,
        );
      }
      referencesInsideSteps.push(...allStepReferences);
      contextsInsideSteps += expected.length;
    }
  }
  assert.deepEqual(
    secretReferences(source).toSorted(),
    referencesInsideSteps.toSorted(),
    "Every secret reference must be inside an allowlisted step-level env map",
  );
  assert.equal(
    secretContextOccurrences(source).length,
    contextsInsideSteps,
    "Every secrets-context occurrence must be an exact allowlisted step-level env expression",
  );
}

function assertGithubTokenAllowlist(source, allowedByJob) {
  const jobs = jobBlocks(source);
  let expectedTotal = 0;
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of parseSteps(job)) {
      const expectedEnvKey = allowedByJob[jobName]?.[step.name];
      const expectedCount = expectedEnvKey ? 1 : 0;
      assert.equal(
        githubTokenOccurrences(step.block.join("\n")).length,
        expectedCount,
        `${jobName}/${step.name} github.token allowlist`,
      );
      if (expectedEnvKey) {
        assert.equal(
          stepMap(step, "env")[expectedEnvKey],
          GITHUB_TOKEN_EXPRESSION,
          `${jobName}/${step.name}/${expectedEnvKey} must use the exact github.token expression`,
        );
      }
      expectedTotal += expectedCount;
    }
  }
  assert.equal(
    githubTokenOccurrences(source).length,
    expectedTotal,
    "Every github.token occurrence must be inside its allowlisted step-level env map",
  );
}

function assertBooleanCredentialProbe(step) {
  assert.equal(stepScalar(step, "id"), "credentials");
  assert.deepEqual(stepMap(step, "env"), {
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  });
  const notice = CREDENTIAL_PROBE_NOTICES[step.name];
  assert.ok(notice, `Missing exact credential probe contract for ${step.name}`);
  assert.equal(
    stepRun(step),
    [
      "set -euo pipefail",
      'if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then',
      '  echo "ready=true" >> "$GITHUB_OUTPUT"',
      "else",
      '  echo "ready=false" >> "$GITHUB_OUTPUT"',
      `  echo "${notice}"`,
      "fi",
    ].join("\n"),
    `${step.name} must contain only the exact boolean credential probe`,
  );
}

function assertSharedGateStep(step, { target, config }) {
  assert.equal(stepScalar(step, "id"), "credentials");
  assert.equal(stepRun(step), "bash scripts/deploy-gate.sh");
  assert.deepEqual(stepMap(step, "env"), {
    ...CLOUDFLARE_SECRET_EXPRESSIONS,
    PRODUCTION_DEPLOY_DISABLED: "${{ vars.PRODUCTION_DEPLOY_DISABLED }}",
    DEPLOY_TARGET: target,
    DEPLOY_WRANGLER_CONFIG: config,
  });
}

function assertChecks(source, pins) {
  assertCommonSourceSafety(source);
  assertGithubContextAllowlist(source, "checks");
  assertExactEvents(source, {
    pull_request: {
      branches: ["main", "base/**"],
      paths: expectedPaths("doc-checks"),
      types: ["opened", "synchronize", "reopened"],
    },
    push: { branches: ["main"], paths: expectedPaths("doc-checks") },
  });
  assert.deepEqual(directMap(source, "concurrency", 0), {
    group: "${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  const jobs = jobBlocks(source);
  assert.deepEqual(Object.keys(jobs), ["checks"]);
  const steps = assertCommonBuildJob(jobs.checks, pins);
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Checkout full history",
      "Setup pnpm",
      "Setup Node.js",
      "Install dependencies",
      "Run documentation aggregate",
      "Run documentation tooling tests",
    ],
  );
  assertSecretAllowlist(source, {});
  assertGithubTokenAllowlist(source, {});
  assert.doesNotMatch(source, /CLOUDFLARE_|github\.token|doc-history-generate|wrangler/u);
}

function assertDeploy(source, pins) {
  assertCommonSourceSafety(source, {
    allowedVarsExpressions: ["${{ vars.PRODUCTION_DEPLOY_DISABLED }}"],
  });
  assertGithubContextAllowlist(source, "deploy");
  assertExactEvents(source, {
    push: { branches: ["main"], paths: expectedPaths("doc-deploy") },
    workflow_dispatch: {},
  });
  assert.deepEqual(directMap(source, "concurrency", 0), {
    group: "doc-deploy-production",
    "cancel-in-progress": "false",
  });
  const jobs = jobBlocks(source);
  assert.deepEqual(Object.keys(jobs), ["deploy"]);
  assert.equal(optionalDirectScalar(jobs.deploy, "outputs", 4), undefined);
  const steps = assertCommonBuildJob(jobs.deploy, pins);
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Checkout full history",
      "Setup pnpm",
      "Setup Node.js",
      "Install dependencies",
      "Run documentation aggregate",
      "Generate published page history",
      "Validate deploy without credentials",
      "Check production credentials",
      "Deploy documentation to production",
    ],
  );
  assert.equal(steps.filter((step) => stepScalar(step, "uses")?.includes("checkout@")).length, 1);

  const aggregate = steps.findIndex((step) => normalizedRun(step) === "pnpm b4push:doc");
  const history = steps.findIndex((step) => normalizedRun(step) === HISTORY_COMMAND);
  const dryRun = steps.findIndex(
    (step) =>
      normalizedRun(step) ===
      "cd doc && pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run",
  );
  const probe = steps.findIndex((step) => step.name === "Check production credentials");
  const live = steps.findIndex(
    (step) => normalizedRun(step) === "cd doc && pnpm exec wrangler deploy",
  );
  assert.ok(aggregate < history && history < dryRun && dryRun < probe && probe < live);
  assert.deepEqual(stepMap(steps[dryRun], "env"), {});
  assertSharedGateStep(steps[probe], {
    target: "documentation site",
    config: "doc/wrangler.toml",
  });
  assert.equal(stepScalar(steps[live], "if"), "steps.credentials.outputs.ready == 'true'");
  assert.deepEqual(stepMap(steps[live], "env"), {
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  });
  assertSecretAllowlist(source, {
    deploy: {
      "Check production credentials": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      "Deploy documentation to production": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
  });
  assertGithubTokenAllowlist(source, {});
  assert.doesNotMatch(source, /--env(?:=|\s)/u);
}

function assertPreview(source, pins, helper) {
  assertCommonSourceSafety(source);
  assertGithubContextAllowlist(source, "preview");
  assertExactEvents(source, {
    pull_request: {
      branches: ["main", "base/**"],
      paths: expectedPaths("doc-preview"),
      types: ["opened", "synchronize", "reopened"],
    },
  });
  assert.deepEqual(directMap(source, "concurrency", 0), {
    group: "doc-preview-${{ github.event.pull_request.number }}",
    "cancel-in-progress": "true",
  });
  assert.doesNotMatch(
    source,
    /<!-- zhs-preview -->|CF_WORKERS_SUBDOMAIN|^\s*group: preview-\$\{\{/mu,
  );
  assert.match(helper, /export const DOC_PREVIEW_COMMENT_MARKER = "<!-- zhs-doc-preview -->";/u);

  const jobs = jobBlocks(source);
  assert.deepEqual(Object.keys(jobs), ["gate", "preview"]);
  assert.equal(directScalar(jobs.gate, "runs-on", 4), "ubuntu-latest");
  assert.equal(directScalar(jobs.gate, "timeout-minutes", 4), "5");
  assertPermissions(jobs.gate, { contents: "read" }, 4);
  assert.deepEqual(directMap(jobs.gate, "outputs", 4), {
    ready: "${{ steps.credentials.outputs.ready || 'false' }}",
  });
  const gateSteps = parseSteps(jobs.gate);
  assert.deepEqual(
    gateSteps.map((step) => step.name),
    ["Explain ineligible fork", "Check preview credentials"],
  );
  assert.equal(
    stepScalar(gateSteps[0], "if"),
    "github.event.pull_request.head.repo.full_name != github.repository",
  );
  assert.equal(stepMap(gateSteps[0], "env").CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(
    stepScalar(gateSteps[1], "if"),
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  assertBooleanCredentialProbe(gateSteps[1]);
  assert.equal(jobs.gate.join("\n").includes("uses: actions/checkout"), false);
  const equalityIndex = source.indexOf(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  const firstSecretIndex = source.search(/\bsecrets\b/u);
  assert.ok(
    equalityIndex >= 0 && firstSecretIndex > equalityIndex,
    "Fork equality guard precedes secrets",
  );

  assert.equal(directScalar(jobs.preview, "needs", 4), "gate");
  assert.equal(directScalar(jobs.preview, "if", 4), "needs.gate.outputs.ready == 'true'");
  const steps = assertCommonBuildJob(jobs.preview, pins, {
    permissions: { contents: "read", "pull-requests": "write" },
    previewHead: true,
  });
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "Checkout exact pull request head with full history",
      "Setup pnpm",
      "Setup Node.js",
      "Install dependencies",
      "Run documentation aggregate",
      "Generate published page history",
      "Create private structured-output path",
      "Upload version and update pull-request alias",
      "Verify deployed commit",
      "Create or update documentation preview comment",
      "Remove structured output",
    ],
  );
  const aggregate = steps.findIndex((step) => normalizedRun(step) === "pnpm b4push:doc");
  const history = steps.findIndex((step) => normalizedRun(step) === HISTORY_COMMAND);
  const output = steps.findIndex((step) => step.name === "Create private structured-output path");
  const upload = steps.findIndex(
    (step) =>
      normalizedRun(step) ===
      'cd doc && pnpm exec wrangler versions upload --preview-alias "pr-${PR_NUMBER}"',
  );
  const revision = steps.findIndex((step) => step.name === "Verify deployed commit");
  const comment = steps.findIndex(
    (step) => normalizedRun(step) === "node scripts/doc-preview-comment.mjs",
  );
  const cleanup = steps.findIndex((step) => step.name === "Remove structured output");
  assert.ok(
    aggregate < history &&
      history < output &&
      output < upload &&
      upload < revision &&
      revision < comment &&
      comment < cleanup,
  );
  assert.match(stepRun(steps[output]), /mktemp "\$RUNNER_TEMP\/zhs-doc-preview\./u);
  assert.deepEqual(stepMap(steps[upload], "env"), {
    CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    PR_NUMBER: "${{ github.event.pull_request.number }}",
    WRANGLER_OUTPUT_FILE_PATH: "${{ steps.output.outputs.path }}",
  });
  assert.doesNotMatch(normalizedRun(steps[upload]), /--env(?:=|\s)|--name(?:=|\s)|--json/u);
  assert.match(stepRun(steps[revision]), /git rev-parse HEAD/u);
  assert.match(stepRun(steps[revision]), /"\$deployed_sha" == "\$EXPECTED_SHA"/u);
  assert.deepEqual(stepMap(steps[comment], "env"), {
    DOC_PREVIEW_OUTPUT_PATH: "${{ steps.output.outputs.path }}",
    GITHUB_REPOSITORY: "${{ github.repository }}",
    GH_TOKEN: "${{ github.token }}",
    PREVIEW_EXPECTED_SHA: "${{ github.event.pull_request.head.sha }}",
    PREVIEW_PR_NUMBER: "${{ github.event.pull_request.number }}",
    PREVIEW_SHA: "${{ steps.revision.outputs.sha }}",
  });
  assert.equal(stepScalar(steps[cleanup], "if"), "always()");
  assertSecretAllowlist(source, {
    gate: {
      "Check preview credentials": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    },
    preview: {
      "Upload version and update pull-request alias": [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
      ],
    },
  });
  assertGithubTokenAllowlist(source, {
    preview: { "Create or update documentation preview comment": "GH_TOKEN" },
  });
  assert.equal(
    steps.filter((step) => Object.hasOwn(stepMap(step, "env"), "WRANGLER_OUTPUT_FILE_PATH")).length,
    1,
  );
}

function assertRunbook(runbook) {
  const start = runbook.indexOf("## Documentation site");
  assert.notEqual(start, -1, "Missing Documentation site runbook section");
  const next = runbook.indexOf("\n## ", start + 1);
  const section = runbook.slice(start, next === -1 ? runbook.length : next).replace(/\s+/gu, " ");
  const required = [
    "production documentation Worker is `zudo-history-stash-docs`",
    "`doc/wrangler.toml` serves Workers Static Assets",
    "`https://zudo-history-stash.zudolab.dev`",
    "active `zudolab.dev` zone",
    "must not already have a CNAME",
    "`[[routes]]` entry has `custom_domain = true`",
    "creates and manages the DNS record and certificate",
    "**Workers Scripts — Edit/Write** on the exact account",
    "**Workers Routes — Edit/Write** on only the `zudolab.dev` zone",
    "needs no D1, R2, KV, or Account Settings grant",
    "**Account Settings — Read is not required**",
    "Wrangler's structured output",
    "instead of depending on `CF_WORKERS_SUBDOMAIN`",
    "Documentation checks need no Cloudflare credentials",
    "performs a credential-free Wrangler dry run",
    "green-skips only the live deploy",
    "skip before upload or comment",
    "`pr-N-zudo-history-stash-docs.<subdomain>.workers.dev`",
    "without shifting production traffic",
    "intentionally public",
    "versions of the one long-lived docs Worker",
    "contain no bearer token",
    "have no close teardown or reaper",
    "may remain reachable after its PR closes",
    "most-recent-1000 alias retention",
    "Never put confidential content in a documentation PR",
    "Cloudflare Access can require sign-in",
    "Full Git history supplies",
    "rotate the credential and remediate Git history separately",
    "do not assume a fixed price, unlimited aliases, universal plan behavior, or immediate cleanup",
  ];
  for (const fragment of required)
    assert.ok(section.includes(fragment), `Runbook omits: ${fragment}`);
  for (const href of [
    "https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/",
    "https://developers.cloudflare.com/workers/wrangler/system-environment-variables/",
    "https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/",
    "https://developers.cloudflare.com/workers/configuration/routing/custom-domains/",
    "https://developers.cloudflare.com/fundamentals/api/reference/permissions/",
    "https://developers.cloudflare.com/workers/platform/limits/",
    "https://developers.cloudflare.com/workers/platform/pricing/",
  ]) {
    assert.ok(section.includes(href), `Runbook omits current source ${href}`);
  }
}

export function validateDocWorkflowSet({ checks, ci, deploy, helper, preview, runbook }) {
  const pins = deriveCiPins(ci);
  assertChecks(checks, pins);
  assertDeploy(deploy, pins);
  assertPreview(preview, pins, helper);
  assertRunbook(runbook);
}

async function sources() {
  const [checks, deploy, preview, ci, helper, runbook] = await Promise.all([
    readFile(WORKFLOW_PATHS.checks, "utf8"),
    readFile(WORKFLOW_PATHS.deploy, "utf8"),
    readFile(WORKFLOW_PATHS.preview, "utf8"),
    readFile(resolve(WORKFLOW_DIRECTORY, "ci.yml"), "utf8"),
    readFile(resolve(ROOT, "scripts/doc-preview-comment.mjs"), "utf8"),
    readFile(resolve(ROOT, "docs/cloudflare-setup.md"), "utf8"),
  ]);
  return { checks, ci, deploy, helper, preview, runbook };
}

function swapUnique(value, left, right) {
  assert.equal(value.split(left).length - 1, 1);
  assert.equal(value.split(right).length - 1, 1);
  return value
    .replace(left, "__DOC_WORKFLOW_SWAP__")
    .replace(right, left)
    .replace("__DOC_WORKFLOW_SWAP__", right);
}

describe("documentation workflows", () => {
  it("satisfies the exact event, trust, history, pin, aggregate, and deploy contracts", async () => {
    const files = (await readdir(WORKFLOW_DIRECTORY))
      .filter((name) => /^doc-.*\.yml$/u.test(name))
      .sort();
    assert.deepEqual(files, ["doc-checks.yml", "doc-deploy.yml", "doc-preview.yml"]);
    validateDocWorkflowSet(await sources());
  });

  it("fails non-vacuously for required security and dependency mutations", async () => {
    const original = await sources();
    const mutations = [
      [
        "required path removed",
        { checks: original.checks.replace('      - "package.json"\n', "") },
      ],
      [
        "full history removed",
        { deploy: original.deploy.replace("          fetch-depth: 0", "          fetch-depth: 1") },
      ],
      [
        "fork equality removed",
        {
          preview: original.preview.replace(
            "github.event.pull_request.head.repo.full_name == github.repository",
            "github.event.pull_request.head.repo.fork == false",
          ),
        },
      ],
      [
        "secret moved ahead of guard",
        {
          preview: original.preview.replace(
            '        run: echo "::notice::Documentation previews are disabled for fork pull requests."',
            [
              "        env:",
              "          EARLY_SECRET: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
              '        run: echo "::notice::Documentation previews are disabled for fork pull requests."',
            ].join("\n"),
          ),
        },
      ],
      [
        "whole secrets context moved ahead of guard",
        {
          preview: original.preview.replace(
            '        run: echo "::notice::Documentation previews are disabled for fork pull requests."',
            [
              "        env:",
              "          EARLY_SECRETS: ${{ toJSON(secrets) }}",
              '        run: echo "::notice::Documentation previews are disabled for fork pull requests."',
            ].join("\n"),
          ),
        },
      ],
      [
        "credential probe prints its secret environment",
        {
          preview: original.preview.replace(
            [
              "          set -euo pipefail",
              '          if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then',
            ].join("\n"),
            [
              "          set -euo pipefail",
              "          printenv",
              '          if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then',
            ].join("\n"),
          ),
        },
      ],
      [
        "job-scoped secret added",
        {
          deploy: original.deploy.replace(
            "    permissions:\n      contents: read",
            [
              "    permissions:",
              "      contents: read",
              "    env:",
              "      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
            ].join("\n"),
          ),
        },
      ],
      [
        "production dry run removed",
        { deploy: original.deploy.replace("wrangler deploy --dry-run", "wrangler deploy") },
      ],
      [
        "production order swapped",
        {
          deploy: swapUnique(
            original.deploy,
            "pnpm b4push:doc",
            "cd doc && pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run",
          ),
        },
      ],
      [
        "action pin changed",
        {
          checks: original.checks.replace(
            "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd",
            "actions/checkout@193cb6efe18208431cddfb8368fd83d5badbf9bfd",
          ),
        },
      ],
      [
        "docs marker changed",
        { helper: original.helper.replace("<!-- zhs-doc-preview -->", "<!-- zhs-preview -->") },
      ],
      [
        "aggregate duplicated",
        {
          checks: original.checks.replace(
            "        run: pnpm b4push:doc",
            "        run: pnpm b4push:doc\n\n      - name: Duplicate aggregate\n        run: pnpm b4push:doc",
          ),
        },
      ],
      [
        "whole GitHub context added to pull-request-controlled aggregate",
        {
          preview: original.preview.replace(
            "      - name: Run documentation aggregate\n        run: pnpm b4push:doc",
            [
              "      - name: Run documentation aggregate",
              "        env:",
              "          GH_CONTEXT: ${{ toJSON(github) }}",
              "        run: pnpm b4push:doc",
            ].join("\n"),
          ),
        },
      ],
      [
        "unapproved repository variable added",
        {
          preview: original.preview.replace(
            "      - name: Run documentation aggregate\n        run: pnpm b4push:doc",
            [
              "      - name: Run documentation aggregate",
              "        env:",
              "          UNAPPROVED_VAR: ${{ vars.SOMETHING_ELSE }}",
              "        run: pnpm b4push:doc",
            ].join("\n"),
          ),
        },
      ],
      [
        "GitHub token added to pull-request-controlled aggregate",
        {
          preview: original.preview.replace(
            "      - name: Run documentation aggregate\n        run: pnpm b4push:doc",
            [
              "      - name: Run documentation aggregate",
              "        env:",
              "          GH_TOKEN: ${{ github.token }}",
              "        run: pnpm b4push:doc",
            ].join("\n"),
          ),
        },
      ],
      [
        "aggregate removed",
        {
          preview: original.preview.replace(
            "        run: pnpm b4push:doc",
            "        run: pnpm build:doc",
          ),
        },
      ],
      [
        "application concurrency substituted",
        {
          preview: original.preview.replace(
            "group: doc-preview-${{ github.event.pull_request.number }}",
            "group: preview-${{ github.event.pull_request.number }}",
          ),
        },
      ],
      [
        "runbook restores Account Settings Read",
        {
          runbook: original.runbook.replace(
            "**Account Settings — Read is not required**",
            "**Account Settings — Read is required**",
          ),
        },
      ],
    ];

    for (const [name, patch] of mutations) {
      for (const [sourceName, mutatedSource] of Object.entries(patch)) {
        assert.notEqual(mutatedSource, original[sourceName], `${name} mutation must apply`);
      }
      assert.throws(
        () => validateDocWorkflowSet({ ...original, ...patch }),
        undefined,
        `${name} must fail validation`,
      );
    }
  });
});
