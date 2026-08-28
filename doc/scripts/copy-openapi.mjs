#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function validateOpenApi(bytes, source) {
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`OpenAPI source is not valid JSON: ${source}`, { cause: error });
  }
  if (document?.openapi !== "3.1.0") {
    throw new Error(`OpenAPI source must declare openapi 3.1.0: ${source}`);
  }
  if (
    document.info === null ||
    typeof document.info !== "object" ||
    typeof document.info.title !== "string" ||
    document.info.title.trim().length === 0 ||
    typeof document.info.version !== "string" ||
    document.info.version.trim().length === 0
  ) {
    throw new Error(`OpenAPI source must contain non-empty info.title and info.version: ${source}`);
  }
  if (
    document.paths === null ||
    typeof document.paths !== "object" ||
    Array.isArray(document.paths)
  ) {
    throw new Error(`OpenAPI source must contain an object paths field: ${source}`);
  }
}

async function existingBytes(path, read) {
  try {
    return await read(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function copyOpenApi({ source, destination, operations = {} }) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  if (sourcePath === destinationPath) {
    throw new Error("OpenAPI source and destination must be different paths");
  }

  const read = operations.readFile ?? readFile;
  const makeDirectory = operations.mkdir ?? mkdir;
  const write = operations.writeFile ?? writeFile;
  const move = operations.rename ?? rename;
  const remove = operations.rm ?? rm;
  const suffix = operations.randomSuffix?.() ?? `${process.pid}-${randomUUID()}`;

  // Validate the canonical bytes before creating or touching anything at the destination.
  const sourceBytes = await read(sourcePath);
  validateOpenApi(sourceBytes, sourcePath);

  const current = await existingBytes(destinationPath, read);
  if (current !== null && Buffer.compare(sourceBytes, current) === 0) {
    return { changed: false, bytes: sourceBytes.byteLength };
  }

  const destinationDirectory = dirname(destinationPath);
  await makeDirectory(destinationDirectory, { recursive: true });
  const temporaryPath = resolve(
    destinationDirectory,
    `.${basename(destinationPath)}.${suffix}.tmp`,
  );
  if (dirname(temporaryPath) !== destinationDirectory || temporaryPath === destinationPath) {
    throw new Error("OpenAPI temporary path escaped the destination directory");
  }

  try {
    await write(temporaryPath, sourceBytes, { flag: "wx" });
    await move(temporaryPath, destinationPath);
  } finally {
    await remove(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { changed: true, bytes: sourceBytes.byteLength };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../..");
  copyOpenApi({
    source: resolve(repositoryRoot, "docs/openapi.json"),
    destination: resolve(repositoryRoot, "doc/public/openapi.json"),
  })
    .then(({ bytes, changed }) => {
      console.log(
        `OpenAPI public copy ${changed ? "updated" : "already current"} (${bytes} bytes)`,
      );
    })
    .catch((error) => {
      console.error(`OpenAPI public copy failed: ${error.message}`);
      process.exitCode = 1;
    });
}
