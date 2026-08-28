#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const PRINCIPALS = new Set(["open", "any", "admin", "admin-or-stash", "read", "write"]);
const TRANSPORTS = new Set(["any", "fetch-only"]);

export const REFERENCE_PAGES = new Set([
  "architecture.mdx",
  "client-package.mdx",
  "core-package.mdx",
  "error-codes.mdx",
  "http-api/change-feeds.mdx",
  "http-api/files-history-and-diffs.mdx",
  "http-api/garbage-collection.mdx",
  "http-api/health-and-identity.mdx",
  "http-api/import.mdx",
  "http-api/index.mdx",
  "http-api/live-events.mdx",
  "http-api/proposals.mdx",
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
    createProposal: "http-api/proposals.mdx",
    listProposals: "http-api/proposals.mdx",
    getProposal: "http-api/proposals.mdx",
    getProposalDiff: "http-api/proposals.mdx",
    approveProposal: "http-api/proposals.mdx",
    rejectProposal: "http-api/proposals.mdx",
    stashEvents: "http-api/live-events.mdx",
    listFiles: "http-api/files-history-and-diffs.mdx",
    getFile: "http-api/files-history-and-diffs.mdx",
    putFile: "http-api/files-history-and-diffs.mdx",
    deleteFile: "http-api/files-history-and-diffs.mdx",
    rollbackFile: "http-api/files-history-and-diffs.mdx",
    getHistory: "http-api/files-history-and-diffs.mdx",
    getDiff: "http-api/files-history-and-diffs.mdx",
    diffCandidate: "http-api/files-history-and-diffs.mdx",
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
  if (!isObject(openApi?.info) || !openApi.info.title || !openApi.info.version) {
    diagnostics.add("openapi: info.title and info.version must be non-empty");
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
      const method = rawMethod.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;
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
      const transport = operation["x-transport"] ?? "any";
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
  const sectionHeading = kind === "error" ? "## Code/status contract" : "## Public numeric exports";
  const lines = visibleLines(source);
  const sectionIndexes = lines
    .map((item, index) => (item.line === sectionHeading ? index : -1))
    .filter((index) => index >= 0);
  if (sectionIndexes.length !== 1) {
    diagnostics.add(
      `${locale}: ${kind} table must have exactly one ${sectionHeading} section, received ${sectionIndexes.length}`,
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
  const pattern =
    kind === "error"
      ? /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*`([0-9]+)`\s*\|/
      : /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*`([0-9]+)`\s*\|/;
  for (const item of lines.slice(start, end)) {
    const match = pattern.exec(item.line);
    if (match === null) continue;
    const [, name, rawValue] = match;
    if (rows.has(name)) {
      diagnostics.add(`${locale}: duplicate ${kind} row ${name} at line ${item.number}`);
      continue;
    }
    rows.set(name, Number(rawValue));
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
    } else if (actual.get(name) !== value) {
      diagnostics.add(
        `${label}: ${kind} ${name} value must be ${value}, received ${actual.get(name)}`,
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
