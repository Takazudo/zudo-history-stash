#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PREVIEW_COMMENT_MARKER = "<!-- zhs-preview -->";
const BOT_LOGIN = "github-actions[bot]";
const MAX_GH_OUTPUT_BYTES = 5_000_000;
const GH_CHILD_SECRET_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "PREVIEW_READ_TOKEN",
  "PW_STASH_TOKEN",
  "STASH_ADMIN_TOKEN",
];

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizedOrigin(value, name) {
  const raw = required(value, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  return parsed.origin;
}

function parseInputs(input) {
  const repository = required(input.repository, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/name");
  }
  const pr = required(input.pr, "PREVIEW_PR_NUMBER");
  if (!/^[1-9]\d*$/u.test(pr)) throw new Error("PREVIEW_PR_NUMBER must be a positive integer");
  const mode = input.mode ?? "active";
  if (mode !== "active" && mode !== "torn-down") {
    throw new Error("PREVIEW_COMMENT_STATE must be active or torn-down");
  }
  if (mode === "torn-down") return { mode, pr, repository };

  const sha = required(input.sha, "PREVIEW_SHA");
  if (!/^[a-fA-F0-9]{40}$/u.test(sha)) throw new Error("PREVIEW_SHA must be a full commit SHA");
  const token = required(input.token, "PREVIEW_READ_TOKEN");
  if (!/^zhs_[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error("PREVIEW_READ_TOKEN has an invalid shape");
  }
  return {
    mode,
    pr,
    repository,
    sha: sha.toLowerCase(),
    stashUrl: normalizedOrigin(input.stashUrl, "PREVIEW_STASH_URL"),
    token,
    viewerUrl: normalizedOrigin(input.viewerUrl, "PREVIEW_VIEWER_URL"),
  };
}

export function renderPreviewComment(input) {
  const values = parseInputs(input);
  if (values.mode === "torn-down") {
    return [
      PREVIEW_COMMENT_MARKER,
      "## PR preview",
      "",
      `Preview resources for pull request #${values.pr} have been torn down.`,
    ].join("\n");
  }
  return [
    PREVIEW_COMMENT_MARKER,
    "## PR preview",
    "",
    `- Viewer: ${values.viewerUrl}`,
    `- Stash API: ${values.stashUrl}`,
    `- Commit: \`${values.sha}\``,
    `- Read-only demo token: \`${values.token}\``,
    "",
    "This token can read the seeded `demo` stash but cannot mutate it.",
  ].join("\n");
}

export function runGh(args, { input = "", env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const childEnv = { ...env };
    for (const name of GH_CHILD_SECRET_ENV) delete childEnv[name];
    const child = spawn("gh", args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_GH_OUTPUT_BYTES) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > MAX_GH_OUTPUT_BYTES) child.kill();
    });
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.stdin.once("error", () =>
      finish(() => rejectPromise(new Error("gh api closed stdin before reading the request"))),
    );
    child.once("close", (code, signal) =>
      finish(() => {
        if (code === 0) resolvePromise(stdout);
        else
          rejectPromise(
            new Error(
              `gh api failed with ${signal ? `signal ${signal}` : `exit code ${String(code)}`}`,
            ),
          );
      }),
    );
    child.stdin.end(input);
  });
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

export async function upsertPreviewComment(input, { gh = runGh } = {}) {
  const values = parseInputs(input);
  const body = renderPreviewComment(values);
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
      (comment.body === PREVIEW_COMMENT_MARKER ||
        comment.body.startsWith(`${PREVIEW_COMMENT_MARKER}\n`)),
  );
  if (matching.length > 1) {
    throw new Error("Multiple bot-owned PR preview comments use the exact marker");
  }

  const existing = matching[0];
  const method = existing ? "PATCH" : "POST";
  if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) {
    throw new Error("The existing PR preview comment has an invalid id");
  }
  const path = existing
    ? `repos/${values.repository}/issues/comments/${String(existing.id)}`
    : commentsPath;
  await gh(
    ["api", "--method", method, "-H", "Accept: application/vnd.github+json", "--input", "-", path],
    { input: `${JSON.stringify({ body })}\n` },
  );
  return { action: existing ? "updated" : "created", commentId: existing?.id ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await upsertPreviewComment({
      pr: process.env.PREVIEW_PR_NUMBER,
      mode: process.env.PREVIEW_COMMENT_STATE ?? "active",
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.PREVIEW_SHA,
      stashUrl: process.env.PREVIEW_STASH_URL,
      token: process.env.PREVIEW_READ_TOKEN,
      viewerUrl: process.env.PREVIEW_VIEWER_URL,
    });
    console.log(`PR preview comment ${result.action}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
