#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DOC_PREVIEW_COMMENT_MARKER = "<!-- zhs-doc-preview -->";
export const MAX_WRANGLER_OUTPUT_BYTES = 1_000_000;
export const MAX_WRANGLER_OUTPUT_LINES = 500;
export const MAX_GH_OUTPUT_BYTES = 1_000_000;

const BOT_LOGIN = "github-actions[bot]";
const WORKER_NAME = "zudo-history-stash-docs";
const GH_ENV_ALLOWLIST = [
  "FORCE_COLOR",
  "GH_HOST",
  "GH_TOKEN",
  "HOME",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "XDG_CONFIG_HOME",
];

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function parseInputs(input) {
  const repository = required(input.repository, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  const pr = required(input.pr, "PREVIEW_PR_NUMBER");
  if (!/^[1-9]\d*$/u.test(pr)) {
    throw new Error("PREVIEW_PR_NUMBER must be a positive integer");
  }
  const sha = required(input.sha, "PREVIEW_SHA");
  const expectedSha = required(input.expectedSha, "PREVIEW_EXPECTED_SHA");
  if (!/^[a-f0-9]{40}$/u.test(sha) || !/^[a-f0-9]{40}$/u.test(expectedSha)) {
    throw new Error("Documentation preview SHAs must be full lowercase commit SHAs");
  }
  if (sha !== expectedSha) {
    throw new Error("Checked-out commit does not match the pull-request head SHA");
  }
  return { expectedSha, pr, repository, sha };
}

function exactHttpsOrigin(value, name) {
  const raw = required(value, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (raw !== parsed.origin && raw !== `${parsed.origin}/`)
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return parsed;
}

function validateVersionUpload(record, pr) {
  if (record.version !== 1) {
    throw new Error("Wrangler version-upload record has an unsupported version");
  }
  if (record.worker_name !== WORKER_NAME) {
    throw new Error("Wrangler version-upload record names the wrong Worker");
  }
  if (record.worker_name_overridden !== false) {
    throw new Error("Wrangler version-upload record must not override the Worker name");
  }
  if (
    record.wrangler_environment !== undefined &&
    record.wrangler_environment !== null &&
    record.wrangler_environment !== ""
  ) {
    throw new Error("Wrangler version-upload record must not select an environment");
  }
  if (typeof record.version_id !== "string" || !record.version_id.trim()) {
    throw new Error("Wrangler version-upload record is missing a version ID");
  }

  const preview = exactHttpsOrigin(record.preview_url, "Wrangler preview_url");
  const alias = exactHttpsOrigin(record.preview_alias_url, "Wrangler preview_alias_url");
  if (preview.origin === alias.origin) {
    throw new Error("Wrangler preview_alias_url must not be the per-version preview URL");
  }

  const firstLabel = `pr-${pr}-${WORKER_NAME}`;
  const suffix = ".workers.dev";
  if (firstLabel.length > 63 || !alias.hostname.endsWith(suffix)) {
    throw new Error("Wrangler preview_alias_url does not match this pull request and Worker");
  }
  const labels = alias.hostname.slice(0, -suffix.length).split(".");
  if (
    labels.length !== 2 ||
    labels[0] !== firstLabel ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(labels[1])
  ) {
    throw new Error("Wrangler preview_alias_url does not match this pull request and Worker");
  }
  return alias.origin;
}

export function parseWranglerOutput(value, pr) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.byteLength > MAX_WRANGLER_OUTPUT_BYTES) {
    throw new Error("Wrangler structured output exceeds the byte limit");
  }
  const rawLines = bytes.toString("utf8").split(/\r?\n/u);
  if (rawLines.length > MAX_WRANGLER_OUTPUT_LINES) {
    throw new Error("Wrangler structured output exceeds the line limit");
  }

  const records = rawLines
    .filter((line) => line.trim())
    .map((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("Wrangler structured output contains malformed JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Wrangler structured output contains a malformed record");
      }
      return parsed;
    });
  if (records.some((record) => record.type === "command-failed")) {
    throw new Error("Wrangler reported a failed command");
  }
  const uploads = records.filter((record) => record.type === "version-upload");
  if (uploads.length !== 1) {
    throw new Error("Wrangler structured output must contain exactly one version upload");
  }
  return validateVersionUpload(uploads[0], pr);
}

async function readValidatedAlias(outputPath, pr) {
  let metadata;
  try {
    metadata = await stat(outputPath);
  } catch {
    throw new Error("Wrangler structured output is unavailable");
  }
  if (!metadata.isFile() || metadata.size > MAX_WRANGLER_OUTPUT_BYTES) {
    throw new Error("Wrangler structured output is not a bounded regular file");
  }
  let contents;
  try {
    contents = await readFile(outputPath);
  } catch {
    throw new Error("Wrangler structured output could not be read");
  }
  return parseWranglerOutput(contents, pr);
}

async function removeOutputFile(outputPath) {
  try {
    await unlink(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Wrangler structured output could not be removed");
    }
  }
}

export function renderDocPreviewComment({ aliasUrl, sha }) {
  return [
    DOC_PREVIEW_COMMENT_MARKER,
    "## Documentation preview",
    "",
    `- Preview: ${aliasUrl}`,
    `- Commit: \`${sha}\``,
    "",
    "This documentation preview is public; do not put confidential content in the pull request.",
  ].join("\n");
}

function parseCommentPages(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("gh api returned malformed comment JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) {
    throw new Error("gh api returned malformed comment JSON");
  }
  return parsed.flat();
}

function childEnvironment(env) {
  const result = {};
  for (const name of GH_ENV_ALLOWLIST) {
    if (typeof env[name] === "string" && env[name]) result[name] = env[name];
  }
  return result;
}

export function runGh(
  args,
  { input = "", env = process.env, maxOutputBytes = MAX_GH_OUTPUT_BYTES, spawnImpl = spawn } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImpl("gh", args, {
        env: childEnvironment(env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectPromise(new Error("Unable to start gh api"));
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const collect = (stream, include) => {
      stream.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        if (include) stdoutBytes += buffer.byteLength;
        else stderrBytes += buffer.byteLength;
        if (stdoutBytes > maxOutputBytes || stderrBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill();
          return;
        }
        if (include) stdout += buffer.toString("utf8");
      });
    };
    collect(child.stdout, true);
    collect(child.stderr, false);
    child.once("error", () => finish(() => rejectPromise(new Error("Unable to start gh api"))));
    child.stdin.once("error", () => {
      child.kill();
      finish(() => rejectPromise(new Error("gh api closed stdin before reading the request")));
    });
    child.once("close", (code, signal) =>
      finish(() => {
        if (outputExceeded) {
          rejectPromise(new Error("gh api output exceeded the safety limit"));
        } else if (code === 0 && !signal) {
          resolvePromise(stdout);
        } else {
          rejectPromise(new Error("gh api did not complete successfully"));
        }
      }),
    );
    child.stdin.end(input);
  });
}

export async function upsertDocPreviewComment(input, { gh = runGh } = {}) {
  const outputPath = required(input.outputPath, "DOC_PREVIEW_OUTPUT_PATH");
  try {
    const values = parseInputs(input);
    const aliasUrl = await readValidatedAlias(outputPath, values.pr);
    const body = renderDocPreviewComment({ aliasUrl, sha: values.sha });
    const commentsPath = `repos/${values.repository}/issues/${values.pr}/comments`;
    const listed = await gh([
      "api",
      "--method",
      "GET",
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
      `${commentsPath}?per_page=100`,
    ]);
    const matching = parseCommentPages(listed).filter(
      (comment) =>
        comment &&
        typeof comment === "object" &&
        comment.user?.login === BOT_LOGIN &&
        typeof comment.body === "string" &&
        (comment.body === DOC_PREVIEW_COMMENT_MARKER ||
          comment.body.startsWith(`${DOC_PREVIEW_COMMENT_MARKER}\n`)),
    );
    if (matching.length > 1) {
      throw new Error("Multiple bot-owned documentation preview comments use the exact marker");
    }

    const existing = matching[0];
    if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) {
      throw new Error("The existing documentation preview comment has an invalid id");
    }
    const method = existing ? "PATCH" : "POST";
    const path = existing
      ? `repos/${values.repository}/issues/comments/${String(existing.id)}`
      : commentsPath;
    await gh(
      [
        "api",
        "--method",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "--input",
        "-",
        path,
      ],
      { input: `${JSON.stringify({ body })}\n` },
    );
    return { action: existing ? "updated" : "created", commentId: existing?.id ?? null };
  } finally {
    await removeOutputFile(outputPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await upsertDocPreviewComment({
      expectedSha: process.env.PREVIEW_EXPECTED_SHA,
      outputPath: process.env.DOC_PREVIEW_OUTPUT_PATH,
      pr: process.env.PREVIEW_PR_NUMBER,
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.PREVIEW_SHA,
    });
    console.log(`Documentation preview comment ${result.action}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Documentation preview comment failed");
    process.exitCode = 1;
  }
}
