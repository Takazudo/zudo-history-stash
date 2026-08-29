#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontmatter } from "@takazudo/zfb/frontmatter";

const OPENAPI_METHODS = new Map(
  ["get", "post", "put", "delete", "patch", "head", "options", "trace"].map((method) => [
    method,
    method.toUpperCase(),
  ]),
);
const HTTP_METHODS = new Set(OPENAPI_METHODS.values());
const PRINCIPALS = new Set(["open", "any", "admin", "admin-or-stash", "read", "write"]);
const TRANSPORTS = new Set(["any", "fetch-only"]);
const GUIDE_FACT_PATHS = [
  "guides/consumer-write-protocol.mdx",
  "guides/service-binding-and-rpc.mdx",
];

export const REFERENCE_PAGES = new Set([
  "architecture.mdx",
  "client-package.mdx",
  "core-package.mdx",
  "error-codes.mdx",
  "http-api/change-feeds.mdx",
  "http-api/change-sets.mdx",
  "http-api/commits.mdx",
  "http-api/files-history-and-diffs.mdx",
  "http-api/garbage-collection.mdx",
  "http-api/health-and-identity.mdx",
  "http-api/import.mdx",
  "http-api/index.mdx",
  "http-api/live-events.mdx",
  "http-api/stashes.mdx",
  "http-api/tokens.mdx",
  "index.mdx",
  "limits.mdx",
  "ui-package.mdx",
  "versions.mdx",
  "viewer-url-scheme.mdx",
]);

export const ROUTE_OWNERS = new Map(
  Object.entries({
    health: "http-api/health-and-identity.mdx",
    me: "http-api/health-and-identity.mdx",
    listStashes: "http-api/stashes.mdx",
    createStash: "http-api/stashes.mdx",
    getStash: "http-api/stashes.mdx",
    deleteStash: "http-api/stashes.mdx",
    restoreStash: "http-api/stashes.mdx",
    createToken: "http-api/tokens.mdx",
    listTokens: "http-api/tokens.mdx",
    rotateToken: "http-api/tokens.mdx",
    revokeToken: "http-api/tokens.mdx",
    importHistory: "http-api/import.mdx",
    listChanges: "http-api/change-feeds.mdx",
    getStashChanges: "http-api/change-feeds.mdx",
    runGc: "http-api/garbage-collection.mdx",
    listGcRuns: "http-api/garbage-collection.mdx",
    createCommit: "http-api/commits.mdx",
    getCommit: "http-api/commits.mdx",
    listCommits: "http-api/commits.mdx",
    getCommitDiff: "http-api/commits.mdx",
    revertCommit: "http-api/commits.mdx",
    getSnapshot: "http-api/commits.mdx",
    createChangeSet: "http-api/change-sets.mdx",
    listChangeSets: "http-api/change-sets.mdx",
    getChangeSet: "http-api/change-sets.mdx",
    getChangeSetDiff: "http-api/change-sets.mdx",
    approveChangeSet: "http-api/change-sets.mdx",
    rejectChangeSet: "http-api/change-sets.mdx",
    stashEvents: "http-api/live-events.mdx",
    listFiles: "http-api/files-history-and-diffs.mdx",
    getFile: "http-api/files-history-and-diffs.mdx",
    putFile: "http-api/files-history-and-diffs.mdx",
    deleteFile: "http-api/files-history-and-diffs.mdx",
    rollbackFile: "http-api/files-history-and-diffs.mdx",
    getHistory: "http-api/files-history-and-diffs.mdx",
    getDiff: "http-api/files-history-and-diffs.mdx",
    diffCandidate: "http-api/files-history-and-diffs.mdx",
    getCapabilities: "http-api/health-and-identity.mdx",
    getRawFile: "http-api/files-history-and-diffs.mdx",
    headRawFile: "http-api/files-history-and-diffs.mdx",
    getRawVersion: "http-api/files-history-and-diffs.mdx",
    headRawVersion: "http-api/files-history-and-diffs.mdx",
    createUploadSession: "http-api/files-history-and-diffs.mdx",
    getUploadSession: "http-api/files-history-and-diffs.mdx",
    abortUploadSession: "http-api/files-history-and-diffs.mdx",
    uploadSingleContent: "http-api/files-history-and-diffs.mdx",
    uploadPart: "http-api/files-history-and-diffs.mdx",
    completeUploadSession: "http-api/files-history-and-diffs.mdx",
    resumeUploadSession: "http-api/files-history-and-diffs.mdx",
  }),
);

export class ContractCheckError extends Error {
  constructor(diagnostics) {
    super(`Contract check failed:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
    this.name = "ContractCheckError";
    this.diagnostics = diagnostics;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticSet() {
  const values = new Set();
  return {
    add(message) {
      values.add(message);
    },
    sorted() {
      return [...values].sort((left, right) => left.localeCompare(right));
    },
  };
}

function finishDiagnostics(diagnostics) {
  const sorted = diagnostics.sorted();
  if (sorted.length > 0) throw new ContractCheckError(sorted);
}

function routeKey(method, path) {
  return `${method} ${path}`;
}

export function normalizeCoreTemplate(template) {
  if (typeof template !== "string" || !template.startsWith("/")) {
    throw new Error(`invalid Core route template ${JSON.stringify(template)}`);
  }
  const segments = template.split("/");
  return segments
    .map((segment, index) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`invalid Core parameter segment ${segment}`);
        }
        return `{${name}}`;
      }
      if (segment.startsWith("*")) {
        const name = segment.slice(1);
        if (index !== segments.length - 1 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(`Core wildcard must be one named terminal segment: ${segment}`);
        }
        return `{${name}}`;
      }
      return segment;
    })
    .join("/");
}

function addUniqueRoute(map, value, label, diagnostics) {
  const key = routeKey(value.method, value.path);
  const existing = map.get(key);
  if (existing !== undefined) {
    diagnostics.add(
      `${label}: duplicate route ${key} (${existing.location ?? existing.id} and ${value.location ?? value.id})`,
    );
    return;
  }
  map.set(key, value);
}

function coreRouteMap(core, diagnostics) {
  if (!Array.isArray(core?.ROUTES) || core.ROUTES.length === 0) {
    diagnostics.add("core: ROUTES must be a non-empty public array");
    return new Map();
  }
  const result = new Map();
  const operationIds = new Set();
  for (const route of core.ROUTES) {
    if (!isObject(route)) {
      diagnostics.add("core: ROUTES contains a non-object entry");
      continue;
    }
    const method = route.method;
    if (!HTTP_METHODS.has(method)) {
      diagnostics.add(`core: route ${route.id ?? "<unknown>"} has unsupported method ${method}`);
      continue;
    }
    if (typeof route.id !== "string" || route.id.length === 0) {
      diagnostics.add(`core: ${method} ${route.template ?? "<unknown>"} has an empty operation id`);
      continue;
    }
    if (operationIds.has(route.id)) diagnostics.add(`core: duplicate operation id ${route.id}`);
    operationIds.add(route.id);
    if (!PRINCIPALS.has(route.principal)) {
      diagnostics.add(`core: operation ${route.id} has unknown principal ${route.principal}`);
    }
    let transport = "any";
    try {
      transport =
        typeof core.transportForRoute === "function"
          ? core.transportForRoute(route.id)
          : (route.transport ?? "any");
    } catch (error) {
      diagnostics.add(`core: operation ${route.id} transport lookup failed: ${error.message}`);
    }
    if (!TRANSPORTS.has(transport)) {
      diagnostics.add(`core: operation ${route.id} has unknown transport ${transport}`);
    }
    let path;
    try {
      path = normalizeCoreTemplate(route.template);
    } catch (error) {
      diagnostics.add(`core: operation ${route.id} ${error.message}`);
      continue;
    }
    addUniqueRoute(
      result,
      { method, path, id: route.id, principal: route.principal, transport },
      "core",
      diagnostics,
    );
  }
  return result;
}

function openApiRouteMap(openApi, diagnostics) {
  if (openApi?.openapi !== "3.1.0") diagnostics.add("openapi: document must declare 3.1.0");
  for (const field of ["title", "version"]) {
    const value = openApi?.info?.[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      diagnostics.add(`openapi: info.${field} must be a non-empty string`);
    }
  }
  if (!isObject(openApi?.paths)) {
    diagnostics.add("openapi: paths must be an object");
    return new Map();
  }
  const result = new Map();
  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(openApi.paths)) {
    if (!isObject(pathItem)) {
      diagnostics.add(`openapi: path item ${path} must be an object`);
      continue;
    }
    if (!path.startsWith("/") || /(^|\/)[:*][^/]+/.test(path)) {
      diagnostics.add(`openapi: public path uses invalid internal notation ${path}`);
    }
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = OPENAPI_METHODS.get(rawMethod);
      if (method === undefined) {
        const canonicalMethod = rawMethod.toLocaleLowerCase("en-US");
        if (OPENAPI_METHODS.has(canonicalMethod)) {
          diagnostics.add(
            `openapi: method key ${rawMethod} at ${path} must be lowercase ${canonicalMethod}`,
          );
        }
        continue;
      }
      if (!isObject(operation)) {
        diagnostics.add(`openapi: operation ${method} ${path} must be an object`);
        continue;
      }
      const id = operation.operationId;
      if (typeof id !== "string" || id.length === 0) {
        diagnostics.add(`openapi: ${method} ${path} has an empty operation id`);
        continue;
      }
      if (operationIds.has(id)) diagnostics.add(`openapi: duplicate operation id ${id}`);
      operationIds.add(id);
      const principal = operation["x-principal"];
      const transport = Object.hasOwn(operation, "x-transport") ? operation["x-transport"] : "any";
      if (!PRINCIPALS.has(principal)) {
        diagnostics.add(`openapi: operation ${id} has unknown principal ${principal}`);
      }
      if (!TRANSPORTS.has(transport)) {
        diagnostics.add(`openapi: operation ${id} has unknown transport ${transport}`);
      }
      addUniqueRoute(result, { method, path, id, principal, transport }, "openapi", diagnostics);
    }
  }
  if (result.size === 0) diagnostics.add("openapi: discovered zero operations");
  return result;
}

async function collectMdxFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`reference directory is missing: ${directory}`);
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".mdx")) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

function visibleLines(source) {
  const result = [];
  const lines = source.split(/\r?\n/);
  let fence = null;
  let comment = null;

  function withoutMdxComments(line) {
    let output = "";
    let cursor = 0;
    while (cursor < line.length) {
      if (comment !== null) {
        const closing = comment === "jsx" ? "*/}" : "-->";
        const close = line.indexOf(closing, cursor);
        if (close === -1) return output;
        cursor = close + closing.length;
        comment = null;
        continue;
      }
      const jsx = line.indexOf("{/*", cursor);
      const html = line.indexOf("<!--", cursor);
      const openings = [
        ...(jsx === -1 ? [] : [{ index: jsx, kind: "jsx" }]),
        ...(html === -1 ? [] : [{ index: html, kind: "html" }]),
      ].sort((left, right) => left.index - right.index);
      if (openings.length === 0) return output + line.slice(cursor);
      output += line.slice(cursor, openings[0].index);
      cursor = openings[0].index + (openings[0].kind === "jsx" ? 3 : 4);
      comment = openings[0].kind;
    }
    return output;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (fence !== null) {
      const closing = /^\s*([`~]{3,})/.exec(rawLine)?.[1];
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const line = withoutMdxComments(rawLine);
    const opening = /^\s*([`~]{3,})/.exec(line)?.[1];
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    result.push({ line, number: index + 1 });
  }
  return result;
}

function anchoredFrontmatter(source) {
  const opener = /^(?:\uFEFF)?---(\r\n|\n|\r)/u.exec(source);
  if (opener === null) return null;
  const newline = opener[1];
  const escapedNewline = newline.replace(/\r/gu, "\\r").replace(/\n/gu, "\\n");
  const closerPattern = new RegExp(`${escapedNewline}---(?:${escapedNewline}|$)`, "gu");
  closerPattern.lastIndex = opener[0].length;
  const closer = closerPattern.exec(source);
  if (closer === null) return null;
  const header = source.slice(opener[0].length, closer.index);
  const descriptionKeys = header
    .split(/\r\n|\n|\r/gu)
    .filter((line) => /^description\s*:/u.test(line));
  if (descriptionKeys.length !== 1) return null;
  try {
    return parseFrontmatter(source).data;
  } catch {
    return null;
  }
}

function formattedCoreLimit(core, name, expected, diagnostics) {
  const value = core?.[name];
  if (!Number.isSafeInteger(value) || value <= 0) {
    diagnostics.add(`core: ${name} must be a positive safe integer for guide facts`);
    return new Intl.NumberFormat("en-US").format(expected);
  }
  if (value !== expected) {
    diagnostics.add(`core: ${name} guide fact value must be ${expected}, received ${value}`);
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function guideFactContracts(core, locale, diagnostics) {
  const bodyLimit = core?.BODY_LIMIT_BYTES;
  const bodyLimitBytes = formattedCoreLimit(
    core,
    "BODY_LIMIT_BYTES",
    32 * 1_024 * 1_024,
    diagnostics,
  );
  const maxBodyBytes = formattedCoreLimit(core, "MAX_BODY_BYTES", 5_000_000, diagnostics);
  const bodyLimitMiB =
    Number.isSafeInteger(bodyLimit) && bodyLimit > 0 ? bodyLimit / (1_024 * 1_024) : 32;
  if (!Number.isInteger(bodyLimitMiB)) {
    diagnostics.add(`core: BODY_LIMIT_BYTES must resolve to a whole MiB guide fact`);
  }

  if (locale === "en") {
    return [
      {
        name: "search-discoverability",
        path: GUIDE_FACT_PATHS[0],
        frontmatter: {
          field: "description",
          value:
            "Use putLatest, compare-and-set fences, and idempotency keys without overwriting concurrent work.",
        },
      },
      {
        name: "idempotency-ledger-ownership",
        path: GUIDE_FACT_PATHS[0],
        text: "A write refused before commit does not create a new ledger record, and a successful `skipIfUnchanged` no-op does not claim its key. A transport or `internal` outcome can be ambiguous; keep the same canonical request under the same key until resolved.",
      },
      {
        name: "rpc-payload-boundaries",
        path: GUIDE_FACT_PATHS[1],
        text: `RPC raises neither the platform nor API limits. Cloudflare's outer serialized RPC value payload is capped at ${bodyLimitMiB} MiB, including envelope overhead, so an application value of exactly ${bodyLimitBytes} bytes is not guaranteed to reach dispatch. A \`Request\` or \`Response\` sent through the flow-controlled \`requestStream()\` bridge is RPC-aware: its body stream is not serialized into that value payload. The SDK selects this bridge for raw, capabilities, and upload routes when the binding exposes it. That transport boundary is independent from Stash's content policy: the compatibility JSON/change set/import path is text-only with a ${maxBodyBytes} UTF-8-byte body rule, while raw uploads preserve either text or binary and use the capability settings (\`HTTP_REQUEST_MAX_BYTES=100000000\`, \`SINGLE_UPLOAD_MAX_BYTES=33554432\`, and multipart above the single limit). Above ${maxBodyBytes} bytes does not imply binary; valid UTF-8 remains text. Representation, content access, transfer, storage tier, and diff eligibility are independent. Use the stream bridge or an HTTP service binding when a structured RPC value cannot fit the envelope; multipart selection still follows server capabilities rather than serving as an RPC-size workaround. Do not claim runtime Cloudflare-plan discovery.`,
      },
    ];
  }
  if (locale === "ja") {
    return [
      {
        name: "search-discoverability",
        path: GUIDE_FACT_PATHS[0],
        frontmatter: {
          field: "description",
          value:
            "putLatest、compare-and-set フェンス、冪等性キーを使用し、並行処理による変更を上書きせずに書き込みます。",
        },
      },
      {
        name: "idempotency-ledger-ownership",
        path: GUIDE_FACT_PATHS[0],
        text: "コミット前に拒否された書き込みでは新しい台帳レコードは作成されず、成功した `skipIfUnchanged` の no-op でも、そのキーは確保されません。トランスポート障害または `internal` の結果は完了したかどうかが曖昧なことがあるため、解決するまでは同じ正規リクエストを同じキーで維持してください。",
      },
      {
        name: "rpc-payload-boundaries",
        path: GUIDE_FACT_PATHS[1],
        text: `RPC を使用しても、プラットフォームと API のどちらの上限も引き上げられません。Cloudflare の外側のシリアライズ済み RPC value payload は、エンベロープのオーバーヘッドを含めて ${bodyLimitMiB} MiB に制限されるため、ちょうど ${bodyLimitBytes} バイトのアプリケーション value がディスパッチまで到達するとは限りません。\`Request\` または \`Response\` を flow-controlled \`requestStream()\` bridge で渡す場合は RPC-aware であり、body stream はその value payload にシリアライズされません。binding が公開していれば、SDK は raw、capabilities、upload route にこの bridge を選びます。この transport 境界は Stash の content policy とは独立しています。互換性 JSON/change set/import 経路はテキスト専用で ${maxBodyBytes} UTF-8 byte の本文ルールを使います。一方 raw upload は text または binary をそのまま保持し、capabilities の設定（\`HTTP_REQUEST_MAX_BYTES=100000000\`、\`SINGLE_UPLOAD_MAX_BYTES=33554432\`、および single 上限を超えた場合の multipart）を使います。${maxBodyBytes} byte を超えても binary とは限らず、正しい UTF-8 は text のままです。representation、content access、transfer、storage tier、diff eligibility は独立しています。stream bridge または HTTP service binding は、structured RPC value が envelope に収まらない場合に使います。multipart の選択は RPC size の回避策ではなく、引き続き server capabilities に従います。Cloudflare plan の runtime discovery を前提にしないでください。`,
      },
    ];
  }
  diagnostics.add(`${locale}: guide fact contracts are not configured`);
  return [];
}

async function checkGuideFacts(contentRoot, core, locale, diagnostics) {
  const sources = new Map();
  for (const path of GUIDE_FACT_PATHS) {
    try {
      sources.set(path, await readFile(resolve(contentRoot, path), "utf8"));
    } catch (error) {
      diagnostics.add(`${locale}: guide fact source ${path} is unavailable: ${error.message}`);
    }
  }
  for (const fact of guideFactContracts(core, locale, diagnostics)) {
    const source = sources.get(fact.path);
    if (source === undefined) continue;
    if (fact.frontmatter !== undefined) {
      const data = anchoredFrontmatter(source);
      if (data?.[fact.frontmatter.field] !== fact.frontmatter.value) {
        diagnostics.add(
          `${locale}: guide fact ${fact.name} is missing or inverted in ${fact.path}`,
        );
      }
      continue;
    }
    const visible = visibleLines(source)
      .map(({ line }) => line)
      .join("")
      .replace(/\s+/gu, "");
    if (!visible.includes(fact.text.replace(/\s+/gu, ""))) {
      diagnostics.add(`${locale}: guide fact ${fact.name} is missing or inverted in ${fact.path}`);
    }
  }
}

const ROUTE_HEADING = /^###\s+`([A-Z]+)\s+([^`]+)`\s*$/;
const CONTRACT_METADATA =
  /^\*\*Contract:\*\*\s+operation\s+`([^`]+)`;\s+principal\s+`([^`]+)`;\s+transport\s+`([^`]+)`\.\s*$/;

function parseMdxRoutes(sources, locale, diagnostics) {
  const result = new Map();
  const consumedMetadata = new Set();
  const operationIds = new Map();
  for (const source of sources) {
    const lines = visibleLines(source.body);
    for (let index = 0; index < lines.length; index += 1) {
      const item = lines[index];
      if (/^###\s+`[^`]*\/v1\//.test(item.line) && !ROUTE_HEADING.test(item.line)) {
        diagnostics.add(`${locale}: malformed route heading ${source.owner}:${item.number}`);
        continue;
      }
      const heading = ROUTE_HEADING.exec(item.line);
      if (heading === null) continue;
      const [, method, path] = heading;
      if (!HTTP_METHODS.has(method)) {
        diagnostics.add(
          `${locale}: unsupported route method ${method} at ${source.owner}:${item.number}`,
        );
      }
      if (!path.startsWith("/")) {
        diagnostics.add(
          `${locale}: public route path must start with / at ${source.owner}:${item.number}`,
        );
      }
      if (/(^|\/)[:*][^/]+/.test(path)) {
        diagnostics.add(
          `${locale}: public route heading uses internal parameter notation ${method} ${path} at ${source.owner}:${item.number}`,
        );
      }
      let metadataIndex = index + 1;
      while (metadataIndex < lines.length && lines[metadataIndex].line.trim() === "")
        metadataIndex += 1;
      const metadata = lines[metadataIndex];
      const contract = metadata === undefined ? null : CONTRACT_METADATA.exec(metadata.line);
      if (contract === null) {
        const reason = metadata?.line.trim().startsWith("**Contract:**")
          ? "has malformed Contract metadata"
          : "lacks immediate Contract metadata";
        diagnostics.add(
          `${locale}: route ${method} ${path} ${reason} at ${source.owner}:${item.number}`,
        );
        continue;
      }
      consumedMetadata.add(`${source.path}:${metadata.number}`);
      const [, id, principal, transport] = contract;
      const location = `${source.owner}:${item.number}`;
      const previousId = operationIds.get(id);
      if (previousId !== undefined) {
        diagnostics.add(`${locale}: duplicate operation id ${id} (${previousId} and ${location})`);
      } else {
        operationIds.set(id, location);
      }
      if (!PRINCIPALS.has(principal)) {
        diagnostics.add(`${locale}: operation ${id} has unknown principal ${principal}`);
      }
      if (!TRANSPORTS.has(transport)) {
        diagnostics.add(`${locale}: operation ${id} has unknown transport ${transport}`);
      }
      addUniqueRoute(
        result,
        {
          method,
          path,
          id,
          principal,
          transport,
          owner: source.owner,
          location,
        },
        `${locale} mdx`,
        diagnostics,
      );
    }
    for (const item of lines) {
      if (
        CONTRACT_METADATA.test(item.line) &&
        !consumedMetadata.has(`${source.path}:${item.number}`)
      ) {
        diagnostics.add(`${locale}: orphan Contract metadata at ${source.owner}:${item.number}`);
      }
    }
  }
  if (result.size === 0) diagnostics.add(`${locale}: discovered zero MDX operations`);
  return result;
}

function compareRouteMaps(coreRoutes, actualRoutes, label, diagnostics) {
  for (const [key, expected] of coreRoutes) {
    const actual = actualRoutes.get(key);
    if (actual === undefined) {
      diagnostics.add(`${label}: missing route ${key} for operation ${expected.id}`);
      continue;
    }
    for (const field of ["id", "principal", "transport"]) {
      if (actual[field] !== expected[field]) {
        diagnostics.add(
          `${label}: ${key} ${field} must be ${expected[field]}, received ${actual[field]}`,
        );
      }
    }
  }
  for (const [key, actual] of actualRoutes) {
    if (!coreRoutes.has(key)) diagnostics.add(`${label}: unexpected route ${key} (${actual.id})`);
  }
}

function enforceRouteOwners(coreRoutes, mdxRoutes, locale, diagnostics) {
  const coreIds = new Set([...coreRoutes.values()].map((route) => route.id));
  for (const id of coreIds) {
    if (!ROUTE_OWNERS.has(id)) diagnostics.add(`taxonomy: missing page owner for operation ${id}`);
  }
  for (const id of ROUTE_OWNERS.keys()) {
    if (!coreIds.has(id)) diagnostics.add(`taxonomy: unexpected stale operation ${id}`);
  }
  for (const route of mdxRoutes.values()) {
    const expectedOwner = ROUTE_OWNERS.get(route.id);
    if (expectedOwner !== undefined && route.owner !== expectedOwner) {
      diagnostics.add(
        `${locale}: operation ${route.id} owner must be ${expectedOwner}, received ${route.owner}`,
      );
    }
  }
}

function coreErrorMap(core, diagnostics) {
  if (!Array.isArray(core?.ERROR_CODES) || core.ERROR_CODES.length === 0) {
    diagnostics.add("core: ERROR_CODES must be a non-empty public array");
    return new Map();
  }
  if (typeof core.statusForCode !== "function") {
    diagnostics.add("core: statusForCode must be a public function");
    return new Map();
  }
  const result = new Map();
  for (const code of core.ERROR_CODES) {
    if (typeof code !== "string" || code.length === 0) {
      diagnostics.add("core: ERROR_CODES contains an invalid code");
      continue;
    }
    if (result.has(code)) {
      diagnostics.add(`core: duplicate error code ${code}`);
      continue;
    }
    const status = core.statusForCode(code);
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      diagnostics.add(`core: error code ${code} has invalid HTTP status ${status}`);
      continue;
    }
    result.set(code, status);
  }
  return result;
}

function parseStructuredRows(source, kind, locale, diagnostics) {
  const rows = new Map();
  const contract =
    kind === "error"
      ? {
          sectionHeading: "## Code/status contract",
          header: "| Code | HTTP status | Meaning | Recovery |",
          separator: "| --- | ---: | --- | --- |",
          row: /^\| `([a-z][a-z0-9-]*)` \| `([0-9]+)` \| (\S(?:[^|]*\S)?) \| (\S(?:[^|]*\S)?) \|$/,
        }
      : {
          sectionHeading: "## Public numeric exports",
          header: "| Constant | Exact decimal | Display | Meaning |",
          separator: "| --- | ---: | ---: | --- |",
          row: /^\| `([A-Z][A-Z0-9_]*)` \| `([0-9]+)` \| (\S(?:[^|]*\S)?) \| (\S(?:[^|]*\S)?) \|$/,
        };
  const lines = visibleLines(source);
  const sectionIndexes = lines
    .map((item, index) => (item.line === contract.sectionHeading ? index : -1))
    .filter((index) => index >= 0);
  if (sectionIndexes.length !== 1) {
    diagnostics.add(
      `${locale}: ${kind} table must have exactly one ${contract.sectionHeading} section, received ${sectionIndexes.length}`,
    );
    return rows;
  }
  const start = sectionIndexes[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].line)) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end);
  const headerIndex = section.findIndex((item) => item.line.trim() !== "");
  if (headerIndex === -1) {
    diagnostics.add(`${locale}: ${kind} table is missing its exact four-column header`);
    diagnostics.add(`${locale}: discovered zero ${kind} rows`);
    return rows;
  }
  const header = section[headerIndex];
  if (header.line !== contract.header) {
    diagnostics.add(
      `${locale}: ${kind} table header must be ${contract.header}, received ${header.line} at line ${header.number}`,
    );
  }
  const separatorIndex = headerIndex + 1;
  const separator = section[separatorIndex];
  if (separator === undefined || separator.line !== contract.separator) {
    diagnostics.add(
      `${locale}: ${kind} table separator must be ${contract.separator}, received ${separator?.line ?? "<missing>"} at line ${separator?.number ?? header.number + 1}`,
    );
  }

  let tableEnded = false;
  for (const item of section.slice(Math.min(separatorIndex + 1, section.length))) {
    if (item.line.trim() === "") {
      tableEnded = true;
      continue;
    }
    if (tableEnded) {
      if (item.line.trimStart().startsWith("|")) {
        diagnostics.add(
          `${locale}: malformed ${kind} table row outside the contiguous table at line ${item.number}`,
        );
      }
      continue;
    }
    const match = contract.row.exec(item.line);
    if (match === null) {
      diagnostics.add(
        `${locale}: malformed ${kind} table row at line ${item.number}; expected exactly four non-empty cells with backticked identity and decimal value`,
      );
      continue;
    }
    const [, name, rawValue] = match;
    if (rows.has(name)) {
      diagnostics.add(`${locale}: duplicate ${kind} row ${name} at line ${item.number}`);
      continue;
    }
    rows.set(name, { rawValue, value: Number(rawValue) });
  }
  if (rows.size === 0) diagnostics.add(`${locale}: discovered zero ${kind} rows`);
  return rows;
}

function coreLimitMap(core, diagnostics) {
  for (const [name, value] of Object.entries(core ?? {})) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      diagnostics.add(`core: numeric export ${name} must be finite`);
    }
  }
  const result = new Map(
    Object.entries(core ?? {})
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (result.size === 0) diagnostics.add("core: discovered zero finite numeric public exports");
  return result;
}

function comparePairs(expected, actual, label, kind, diagnostics) {
  for (const [name, value] of expected) {
    if (!actual.has(name)) {
      diagnostics.add(`${label}: missing ${kind} row ${name}`);
      continue;
    }
    const received = actual.get(name);
    if (received.value !== value) {
      diagnostics.add(
        `${label}: ${kind} ${name} value must be ${value}, received ${received.value}`,
      );
    } else if (received.rawValue !== String(value)) {
      const field = kind === "error" ? "HTTP status" : "exact decimal";
      diagnostics.add(
        `${label}: ${kind} ${name} ${field} must be spelled ${value}, received ${received.rawValue}`,
      );
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) diagnostics.add(`${label}: unexpected ${kind} row ${name}`);
  }
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is malformed at ${path}: ${error.message}`);
  }
}

async function importCore(path) {
  try {
    const core = await import(pathToFileURL(path).href);
    if (
      !Array.isArray(core.ROUTES) ||
      !Array.isArray(core.ERROR_CODES) ||
      typeof core.statusForCode !== "function" ||
      typeof core.transportForRoute !== "function"
    ) {
      throw new Error("required public route/error exports are absent");
    }
    return core;
  } catch (error) {
    throw new Error(
      `Core public dist is missing or malformed at ${path}. Run pnpm build:libs before check:contract. ${error.message}`,
    );
  }
}

function defaultContentRoots(repositoryRoot) {
  return {
    en: resolve(repositoryRoot, "doc/src/content/docs"),
    ja: resolve(repositoryRoot, "doc/src/content/docs-ja"),
  };
}

export async function checkContract({
  repositoryRoot,
  locales = ["en"],
  contentRoots = defaultContentRoots(repositoryRoot),
  openApi,
  core,
  openApiPath = resolve(repositoryRoot, "docs/openapi.json"),
  coreModulePath = resolve(repositoryRoot, "packages/core/dist/index.js"),
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new TypeError("repositoryRoot is required");
  }
  if (
    !Array.isArray(locales) ||
    locales.length === 0 ||
    !locales.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new TypeError("locales must be a non-empty array of locale names");
  }

  const resolvedOpenApi = openApi ?? (await readJson(openApiPath, "OpenAPI document"));
  const resolvedCore = core ?? (await importCore(coreModulePath));
  const diagnostics = diagnosticSet();
  const coreRoutes = coreRouteMap(resolvedCore, diagnostics);
  const openApiRoutes = openApiRouteMap(resolvedOpenApi, diagnostics);
  compareRouteMaps(coreRoutes, openApiRoutes, "openapi", diagnostics);
  const errors = coreErrorMap(resolvedCore, diagnostics);
  const limits = coreLimitMap(resolvedCore, diagnostics);

  for (const locale of locales) {
    const contentRoot = contentRoots[locale];
    if (typeof contentRoot !== "string" || contentRoot.length === 0) {
      diagnostics.add(`${locale}: content root is not configured`);
      continue;
    }
    await checkGuideFacts(contentRoot, resolvedCore, locale, diagnostics);
    const referenceRoot = resolve(contentRoot, "reference");
    let files;
    try {
      files = await collectMdxFiles(referenceRoot);
    } catch (error) {
      diagnostics.add(`${locale}: ${error.message}`);
      continue;
    }
    const sources = await Promise.all(
      files.map(async (path) => ({
        path,
        owner: relative(referenceRoot, path).split("\\").join("/"),
        body: await readFile(path, "utf8"),
      })),
    );
    const actualPages = new Set(sources.map((source) => source.owner));
    for (const page of REFERENCE_PAGES) {
      if (!actualPages.has(page)) diagnostics.add(`${locale}: missing reference page ${page}`);
    }
    for (const page of actualPages) {
      if (!REFERENCE_PAGES.has(page))
        diagnostics.add(`${locale}: unexpected reference page ${page}`);
    }
    const mdxRoutes = parseMdxRoutes(sources, locale, diagnostics);
    compareRouteMaps(coreRoutes, mdxRoutes, locale, diagnostics);
    enforceRouteOwners(coreRoutes, mdxRoutes, locale, diagnostics);

    const errorSource = sources.find((source) => source.owner === "error-codes.mdx")?.body;
    if (errorSource === undefined) diagnostics.add(`${locale}: missing reference/error-codes.mdx`);
    else {
      const rows = parseStructuredRows(errorSource, "error", locale, diagnostics);
      comparePairs(errors, rows, locale, "error", diagnostics);
    }

    const limitSource = sources.find((source) => source.owner === "limits.mdx")?.body;
    if (limitSource === undefined) diagnostics.add(`${locale}: missing reference/limits.mdx`);
    else {
      const rows = parseStructuredRows(limitSource, "limit", locale, diagnostics);
      comparePairs(limits, rows, locale, "limit", diagnostics);
    }
  }

  finishDiagnostics(diagnostics);
  return {
    routes: coreRoutes.size,
    errors: errors.size,
    limits: limits.size,
    locales: [...locales],
  };
}

function parseCli(argv) {
  const locales = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--locale") {
      const locale = argv[++index];
      if (!locale) throw new Error("--locale requires a value");
      locales.push(locale);
    } else if (argument.startsWith("--locale=")) {
      const locale = argument.slice("--locale=".length);
      if (!locale) throw new Error("--locale requires a value");
      locales.push(locale);
    } else if (argument !== "--") {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return { locales: locales.length === 0 ? ["en"] : locales };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "../..");
  try {
    const { locales } = parseCli(process.argv.slice(2));
    const summary = await checkContract({ repositoryRoot, locales });
    console.log(
      `Contract parity OK (${summary.routes} routes, ${summary.errors} errors, ${summary.limits} limits; ${summary.locales.join(", ")})`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
