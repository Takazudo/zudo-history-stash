#!/usr/bin/env node

import { createStashClient } from "@takazudo/zudo-history-stash";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PREVIEW_TOKEN_LABEL = "PR preview read token";
export const PREVIEW_STASH_NAME = "demo";

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeBaseUrl(value) {
  const baseUrl = required(value, "API_BASE_URL");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("API_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("API_BASE_URL must be a valid HTTP(S) URL");
  }
  return baseUrl.replace(/\/+$/u, "");
}

function resultError(result) {
  if (result && typeof result === "object" && "error" in result) {
    const error = result.error;
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      return new Error(`Minting the preview read token failed (${error.code}): ${error.message}`);
    }
  }
  return new Error("Minting the preview read token returned an invalid result");
}

export async function mintPreviewReadToken({
  baseUrl,
  adminToken,
  outputPath,
  createClient = createStashClient,
  appendOutput = (path, value) => appendFile(path, value, "utf8"),
  writeStdout = (value) => process.stdout.write(value),
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedAdminToken = required(adminToken, "STASH_ADMIN_TOKEN");
  const normalizedOutputPath = required(outputPath, "GITHUB_OUTPUT");
  const admin = createClient({ baseUrl: normalizedBaseUrl, token: normalizedAdminToken });
  const result = await admin.stashes.tokens(PREVIEW_STASH_NAME).create({
    label: PREVIEW_TOKEN_LABEL,
    scope: "read",
  });
  if (!result?.ok) throw resultError(result);

  const { id, label, scope, token } = result.value ?? {};
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(id) ||
    label !== PREVIEW_TOKEN_LABEL ||
    scope !== "read" ||
    typeof token !== "string" ||
    !/^zhs_[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new Error("Minting the preview read token returned an invalid result");
  }

  writeStdout(`::add-mask::${token}\n`);
  await appendOutput(normalizedOutputPath, `token=${token}\ntoken_id=${id}\n`);
  writeStdout(`Minted read-only preview token ${id}.\n`);
  return { id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await mintPreviewReadToken({
      adminToken: process.env.STASH_ADMIN_TOKEN,
      baseUrl: process.env.API_BASE_URL,
      outputPath: process.env.GITHUB_OUTPUT,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
