#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@takazudo/zfb/frontmatter";
import { switchLocaleHref } from "@takazudo/zudo-doc/i18n-version";
import { toRouteSlug } from "@takazudo/zudo-doc/slug";
import { parseZfbConfig } from "./check-links.js";
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_ONLY_PREFIXES,
  LOCALIZED_LOCALE,
  SHARED_GENERATED_SOURCE_PATHS,
} from "../locale-contract.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DOC_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const SHARED_GENERATED_SOURCE_SET = new Set(SHARED_GENERATED_SOURCE_PATHS);
const TECHNICAL_LITERAL = /\b(?:D1|R2|SSE|HTTP|RPC|OpenAPI|CORS|ETags?|CAS|UTF-8)\b/g;
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

export class LocaleParityError extends Error {
  constructor(diagnostics) {
    super(`Locale parity check failed:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`);
    this.name = "LocaleParityError";
    this.diagnostics = diagnostics;
  }
}

function diagnosticSet() {
  const values = new Set();
  return {
    add(message) {
      values.add(message);
    },
    sorted() {
      return [...values].sort((left, right) => left.localeCompare(right, "en"));
    },
  };
}

function finishDiagnostics(diagnostics) {
  const sorted = diagnostics.sorted();
  if (sorted.length > 0) throw new LocaleParityError(sorted);
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function displayPath(path, root) {
  const value = toPosix(relative(root, path));
  return value.startsWith("../") || value === ".." ? path : value;
}

function isInside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function sourceRoute(relativePath) {
  const withoutExtension = relativePath.slice(0, -extname(relativePath).length);
  const slug = toRouteSlug(withoutExtension);
  return slug === "" ? "/docs" : `/docs/${slug}`;
}

function isWithinPrefix(route, prefix) {
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return route === root || route.startsWith(`${root}/`);
}

function defaultOnlyPrefixFor(relativePath) {
  const route = sourceRoute(relativePath);
  return DEFAULT_LOCALE_ONLY_PREFIXES.find((prefix) => isWithinPrefix(route, prefix));
}

function lineRecords(source) {
  const records = [];
  let offset = 0;
  while (offset < source.length) {
    const match = /\r\n|\n|\r/g;
    match.lastIndex = offset;
    const found = match.exec(source);
    const end = found === null ? source.length : found.index + found[0].length;
    const raw = source.slice(offset, end);
    records.push({
      start: offset,
      end,
      raw,
      value: raw.replace(/(?:\r\n|\n|\r)$/, ""),
    });
    offset = end;
  }
  if (source.length === 0) records.push({ start: 0, end: 0, raw: "", value: "" });
  return records;
}

function blankRange(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
  }
}

function inspectFrontmatter(source, label, diagnostics) {
  const opener = /^(?:\uFEFF)?---(\r\n|\n|\r)/.exec(source);
  if (opener === null) {
    diagnostics.add(`${label}: frontmatter/missing: expected a leading --- delimiter`);
    return { body: source, data: {}, keys: [] };
  }
  const newline = opener[1];
  const headerStart = opener[0].length;
  const closerPattern = new RegExp(
    `${newline.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}---(?:${newline.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}|$)`,
    "g",
  );
  closerPattern.lastIndex = headerStart;
  const closer = closerPattern.exec(source);
  if (closer === null) {
    diagnostics.add(`${label}: frontmatter/unclosed: no closing --- delimiter`);
    return { body: "", data: {}, keys: [] };
  }
  const header = source.slice(headerStart, closer.index);
  const keys = [];
  const seen = new Set();
  for (const [index, line] of header.split(/\r\n|\n|\r/).entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#") || /^\s+-\s+/.test(line)) continue;
    const match = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (match === null) {
      diagnostics.add(`${label}: frontmatter/unsupported syntax at line ${index + 2}: ${line}`);
      continue;
    }
    const key = match[1];
    if (seen.has(key)) diagnostics.add(`${label}: frontmatter/duplicate key ${key}`);
    seen.add(key);
    keys.push(key);
  }
  const parsed = parseFrontmatter(source);
  const bodyStart = closer.index + closer[0].length;
  return { body: source.slice(bodyStart), data: parsed.data, keys };
}

function validateGeneratedSource(source, relativePath, kind, diagnostics) {
  const label = `en:${relativePath}`;
  const frontmatter = inspectFrontmatter(source, label, diagnostics);
  if (frontmatter.data.generated !== "true") {
    diagnostics.add(
      `${label}: generated-source/marker: canonical generated source must declare generated: true`,
    );
    return null;
  }
  if (kind === "shared") {
    const expectedKeys = ["title", "description", "sidebar_position", "generated"];
    if (!isDeepStrictEqual(frontmatter.keys, expectedKeys)) {
      diagnostics.add(
        `${label}: generated-source/shape: shared overview keys must be ${expectedKeys.join(", ")}`,
      );
      return null;
    }
    const expectedBody =
      '\n## Resources\n\n<CategoryNav categories={["claude-md","claude-skills"]} />\n';
    if (frontmatter.body !== expectedBody) {
      diagnostics.add(`${label}: generated-source/shape: shared overview body is not canonical`);
      return null;
    }
  }
  return frontmatter;
}

function validateSourceRouteUniqueness(files, locale, diagnostics) {
  const routes = new Map();
  for (const file of files) {
    const route = sourceRoute(file.relativePath).replace(/\/+$/, "").toLocaleLowerCase("en-US");
    const previous = routes.get(route);
    if (previous !== undefined) {
      diagnostics.add(
        `${locale}: discovery/duplicate-route: ${previous} and ${file.relativePath} both normalize to ${route}`,
      );
    } else {
      routes.set(route, file.relativePath);
    }
  }
}

async function discoverFiles(root, locale, diagnostics) {
  const resolvedRoot = resolve(root);
  let rootStat;
  try {
    rootStat = await lstat(resolvedRoot);
  } catch (error) {
    diagnostics.add(
      `${locale}: discovery/root: source root is unavailable at ${resolvedRoot}: ${error.message}`,
    );
    return [];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    diagnostics.add(
      `${locale}: discovery/root: source root must be a real directory: ${resolvedRoot}`,
    );
    return [];
  }

  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.add(`${locale}: discovery/read: cannot read ${directory}: ${error.message}`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!isInside(resolvedRoot, path)) {
        diagnostics.add(`${locale}: discovery/escape: ${path} escapes ${resolvedRoot}`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.add(
          `${locale}: discovery/symlink: symbolic links are forbidden: ${displayPath(path, resolvedRoot)}`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.mdx?$/.test(entry.name)) continue;
      files.push({ path, relativePath: toPosix(relative(resolvedRoot, path)) });
    }
  }
  await visit(resolvedRoot);

  const byFoldedPath = new Map();
  for (const file of files) {
    const folded = file.relativePath.toLocaleLowerCase("en-US");
    const previous = byFoldedPath.get(folded);
    if (previous !== undefined && previous !== file.relativePath) {
      diagnostics.add(`${locale}: discovery/case collision: ${previous} and ${file.relativePath}`);
    } else {
      byFoldedPath.set(folded, file.relativePath);
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

async function loadSiteConfig(configPath, diagnostics) {
  try {
    const config = await parseZfbConfig(configPath);
    if (
      !isDeepStrictEqual(config.localeKeys, [LOCALIZED_LOCALE]) ||
      config.localeDirs.length !== 1
    ) {
      diagnostics.add(
        `config/locales: expected exactly the ${LOCALIZED_LOCALE} locale, received ${config.localeKeys.join(", ") || "<none>"}`,
      );
    }
    return config;
  } catch (error) {
    diagnostics.add(`config/read: ${error.message}`);
    return null;
  }
}

async function buildManifestInternal(options, diagnostics) {
  let siteConfig = null;
  let enRoot;
  let jaRoot;
  if (options.enRoot !== undefined || options.jaRoot !== undefined) {
    if (typeof options.enRoot !== "string" || typeof options.jaRoot !== "string") {
      diagnostics.add("config/roots: injected enRoot and jaRoot must be supplied together");
    }
    enRoot = resolve(options.enRoot ?? join(DOC_DIRECTORY, "__missing-en-root__"));
    jaRoot = resolve(options.jaRoot ?? join(DOC_DIRECTORY, "__missing-ja-root__"));
  } else {
    siteConfig = await loadSiteConfig(
      resolve(options.configPath ?? join(DOC_DIRECTORY, "zfb.config.ts")),
      diagnostics,
    );
    enRoot = resolve(DOC_DIRECTORY, siteConfig?.docsDir ?? "__missing-en-root__");
    jaRoot = resolve(DOC_DIRECTORY, siteConfig?.localeDirs[0] ?? "__missing-ja-root__");
  }
  const [enFiles, jaFiles] = await Promise.all([
    discoverFiles(enRoot, DEFAULT_LOCALE, diagnostics),
    discoverFiles(jaRoot, LOCALIZED_LOCALE, diagnostics),
  ]);
  validateSourceRouteUniqueness(enFiles, DEFAULT_LOCALE, diagnostics);
  validateSourceRouteUniqueness(jaFiles, LOCALIZED_LOCALE, diagnostics);
  const enNormal = new Map();
  const jaNormal = new Map();
  const defaultOnly = [];
  const sharedGenerated = [];

  for (const file of enFiles) {
    const source = await readFile(file.path, "utf8");
    const prefix = defaultOnlyPrefixFor(file.relativePath);
    if (prefix !== undefined) {
      const generated = validateGeneratedSource(
        source,
        file.relativePath,
        "default-only",
        diagnostics,
      );
      if (generated !== null) {
        defaultOnly.push({
          ...file,
          route: sourceRoute(file.relativePath),
          prefix,
          emitsRoute: generated.data.category_no_page !== "true",
        });
      }
      continue;
    }
    if (SHARED_GENERATED_SOURCE_SET.has(file.relativePath)) {
      if (validateGeneratedSource(source, file.relativePath, "shared", diagnostics) !== null) {
        sharedGenerated.push({ ...file, route: sourceRoute(file.relativePath) });
      }
      continue;
    }
    enNormal.set(file.relativePath, file);
  }

  for (const file of jaFiles) {
    if (defaultOnlyPrefixFor(file.relativePath) !== undefined) {
      diagnostics.add(
        `ja:${file.relativePath}: discovery/default-only: localized source under an EN-only prefix is forbidden`,
      );
      continue;
    }
    if (SHARED_GENERATED_SOURCE_SET.has(file.relativePath)) {
      diagnostics.add(
        `ja:${file.relativePath}: discovery/generated: the shared generated overview must remain generator-owned`,
      );
      continue;
    }
    jaNormal.set(file.relativePath, file);
  }

  if (enNormal.size === 0)
    diagnostics.add("en: discovery/empty: discovered zero hand-authored pages");
  if (jaNormal.size === 0)
    diagnostics.add("ja: discovery/empty: discovered zero hand-authored pages");

  const pairs = [];
  for (const [relativePath, en] of enNormal) {
    const ja = jaNormal.get(relativePath);
    if (ja === undefined) {
      diagnostics.add(`pair:${relativePath}: inventory/missing-ja: missing Japanese source twin`);
      continue;
    }
    pairs.push({
      relativePath,
      enPath: en.path,
      jaPath: ja.path,
      route: sourceRoute(relativePath),
    });
  }
  for (const relativePath of jaNormal.keys()) {
    if (!enNormal.has(relativePath)) {
      diagnostics.add(
        `pair:${relativePath}: inventory/extra-ja: Japanese source has no English twin`,
      );
    }
  }
  pairs.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  defaultOnly.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  sharedGenerated.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  return { enRoot, jaRoot, pairs, defaultOnly, sharedGenerated, siteConfig };
}

export async function buildLocaleManifest(options = {}) {
  const diagnostics = diagnosticSet();
  const manifest = await buildManifestInternal(options, diagnostics);
  finishDiagnostics(diagnostics);
  return manifest;
}

function extractFences(body, label, diagnostics) {
  const chars = body.split("");
  const records = lineRecords(body);
  const fences = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(record.value);
    if (opener === null) continue;
    const marker = opener[2];
    const info = opener[3];
    if (marker.startsWith("`") && info.includes("`")) continue;
    const character = marker[0];
    const closePattern = new RegExp(`^ {0,3}\\${character}{${marker.length},}[ \\t]*$`);
    let closeIndex = -1;
    for (let candidate = index + 1; candidate < records.length; candidate += 1) {
      if (closePattern.test(records[candidate].value)) {
        closeIndex = candidate;
        break;
      }
    }
    if (closeIndex === -1) {
      diagnostics.add(`${label}: fence/unclosed: ${marker} fence has no compatible closer`);
      blankRange(chars, record.start, body.length);
      break;
    }
    const end = records[closeIndex].end;
    fences.push(body.slice(record.start, end));
    blankRange(chars, record.start, end);
    index = closeIndex;
  }
  return { fences, masked: chars.join("") };
}

function maskPattern(source, pattern, events, type, mapper = (match) => match[0]) {
  const chars = source.split("");
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (events !== null) events.push({ position: match.index, type, value: mapper(match) });
    blankRange(chars, match.index, match.index + match[0].length);
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return chars.join("");
}

function extractInlineCode(source, label, diagnostics, events) {
  const chars = source.split("");
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "`") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (source[runEnd] === "`") runEnd += 1;
    const marker = source.slice(index, runEnd);
    let close = source.indexOf(marker, runEnd);
    while (close !== -1 && source[close + marker.length] === "`") {
      close = source.indexOf(marker, close + marker.length);
    }
    if (close === -1) {
      diagnostics.add(`${label}: inline-code/unclosed: ${marker} has no closer`);
      blankRange(chars, index, runEnd);
      index = runEnd;
      continue;
    }
    const end = close + marker.length;
    const raw = source.slice(index, end);
    events.push({ position: index, type: "inline-code", value: raw });
    blankRange(chars, index, end);
    index = end;
  }
  return chars.join("");
}

function parseTags(source, label, diagnostics, events) {
  const pattern = /<(\/)?([A-Za-z][A-Za-z0-9.]*)((?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*?)?)(\/?)>/g;
  const chars = source.split("");
  const stack = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const [, closing, name, attributes, selfClosing] = match;
    const kind = closing ? "close" : selfClosing ? "self" : "open";
    const normalizedAttributes = attributes.trim().replace(/\s+/g, " ");
    events.push({
      position: match.index,
      type: "mdx-tag",
      value: `${kind}:${name}:${normalizedAttributes}`,
    });
    if (kind === "open") stack.push(name);
    if (kind === "close") {
      const expected = stack.pop();
      if (expected !== name) {
        diagnostics.add(
          `${label}: mdx-tag/nesting: closing ${name} does not match ${expected ?? "<none>"}`,
        );
      }
    }
    blankRange(chars, match.index, match.index + match[0].length);
  }
  if (stack.length > 0) diagnostics.add(`${label}: mdx-tag/unclosed: ${stack.join(", ")}`);
  return chars.join("");
}

function unescapedPipeIndexes(value) {
  const indexes = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "|") continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) indexes.push(index);
  }
  return indexes;
}

function parseTableRow(record, line) {
  const indexes = unescapedPipeIndexes(record.value);
  if (indexes.length === 0) return null;

  const firstNonWhitespace = record.value.search(/\S/);
  const lastNonWhitespace = record.value.search(/\s*$/) - 1;
  let start = 0;
  let end = record.value.length;
  if (indexes[0] === firstNonWhitespace) {
    start = indexes.shift() + 1;
  }
  if (indexes.at(-1) === lastNonWhitespace) {
    end = indexes.pop();
  }

  const delimiters = indexes.filter((index) => index >= start && index < end);
  const cells = [];
  let cellStart = start;
  for (const delimiter of delimiters) {
    cells.push(record.value.slice(cellStart, delimiter).trim());
    cellStart = delimiter + 1;
  }
  cells.push(record.value.slice(cellStart, end).trim());
  return { cells, line, position: record.start };
}

function isTableSeparator(row) {
  return row !== null && row.cells.length > 0 && row.cells.every((cell) => /^:?-+:?$/.test(cell));
}

function collectTableStructure(source, label, diagnostics, events) {
  const records = lineRecords(source);
  for (let index = 0; index < records.length - 1; index += 1) {
    const header = parseTableRow(records[index], index + 1);
    const separator = parseTableRow(records[index + 1], index + 2);
    if (header === null || !isTableSeparator(separator)) continue;

    const rows = [
      { ...header, role: "header" },
      { ...separator, role: "separator" },
    ];
    let cursor = index + 2;
    while (cursor < records.length) {
      const body = parseTableRow(records[cursor], cursor + 1);
      if (body === null) break;
      rows.push({ ...body, role: "body" });
      cursor += 1;
    }

    const expected = header.cells.length;
    for (const row of rows) {
      events.push({
        position: row.position,
        type: "table-row",
        value: `${row.role}:${row.cells.length}`,
      });
      if (row.cells.length !== expected) {
        diagnostics.add(
          `${label}: table/cell-count at body line ${row.line}: ${row.role} row has ${row.cells.length} cells; header has ${expected}`,
        );
      }
    }
    index = cursor - 1;
  }
}

function collectLineStructure(source, events) {
  for (const record of lineRecords(source)) {
    const heading = /^(#{1,6})\s+/.exec(record.value);
    if (heading !== null) {
      events.push({ position: record.start, type: "heading", value: String(heading[1].length) });
    }
    const list = /^(\s*)([-+*]|\d+[.)])\s+/.exec(record.value);
    if (list !== null) {
      const ordered = /^\d/.test(list[2]) ? "ordered" : "unordered";
      events.push({
        position: record.start,
        type: "list-item",
        value: `${ordered}:${list[1].length}`,
      });
    }
    const admonition = /^\s*:::\s*([A-Za-z][\w-]*)?\s*$/.exec(record.value);
    if (admonition !== null) {
      events.push({
        position: record.start,
        type: "admonition",
        value: admonition[1] ?? "close",
      });
    }
  }
}

function extractDocument(source, label, diagnostics) {
  const frontmatter = inspectFrontmatter(source, label, diagnostics);
  const fenced = extractFences(frontmatter.body, label, diagnostics);
  const events = [];
  const tableSource = maskPattern(fenced.masked, MDX_COMMENT, null, "mdx-comment");
  collectTableStructure(tableSource, label, diagnostics, events);
  let masked = extractInlineCode(fenced.masked, label, diagnostics, events);
  masked = maskPattern(masked, MDX_COMMENT, events, "mdx-comment");
  masked = maskPattern(
    masked,
    /!?\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
    events,
    "link",
    (match) => `${match[0].startsWith("!") ? "image" : "link"}:${match[2]}`,
  );
  masked = parseTags(masked, label, diagnostics, events);
  masked = maskPattern(masked, /^(?:import|export)\b[^\r\n]*(?:\r\n|\n|\r|$)/gm, events, "esm");
  collectLineStructure(masked, events);

  if (/[{}]/.test(masked)) {
    diagnostics.add(`${label}: unsupported syntax: document-level MDX expression`);
  }
  if (/<\/?[A-Za-z]/.test(masked)) {
    diagnostics.add(`${label}: unsupported syntax: unparsed MDX/HTML tag`);
  }
  if (/!?\[[^\]]*\]\(/.test(masked)) {
    diagnostics.add(`${label}: unsupported syntax: malformed Markdown link or image`);
  }

  const numbers = [
    ...masked.matchAll(/(?<![\p{L}\p{N}_])\d(?:[\d_]*\d)?(?:,\d{3})*(?:\.\d+)?(?![\p{L}\p{N}_])/gu),
  ].map((match) => match[0]);
  const technical = [...masked.matchAll(TECHNICAL_LITERAL)].map((match) =>
    match[0] === "ETags" ? "ETag" : match[0],
  );
  events.sort(
    (left, right) => left.position - right.position || left.type.localeCompare(right.type, "en"),
  );
  return {
    frontmatter,
    fences: fenced.fences,
    events: events.map((event) => `${event.type}:${event.value}`),
    numbers,
    technical,
  };
}

function firstDifference(left, right) {
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] !== right[index]) {
      return `item ${index + 1}: EN=${JSON.stringify(left[index] ?? "<missing>")} JA=${JSON.stringify(right[index] ?? "<missing>")}`;
    }
  }
  return "unknown difference";
}

function compareDocuments(enSource, jaSource, relativePath, diagnostics) {
  const enLabel = `en:${relativePath}`;
  const jaLabel = `ja:${relativePath}`;
  const en = extractDocument(enSource, enLabel, diagnostics);
  const ja = extractDocument(jaSource, jaLabel, diagnostics);
  if (!isDeepStrictEqual(en.frontmatter.keys, ja.frontmatter.keys)) {
    diagnostics.add(
      `pair:${relativePath}: frontmatter/key-order: ${firstDifference(en.frontmatter.keys, ja.frontmatter.keys)}`,
    );
  }
  for (const key of new Set([...en.frontmatter.keys, ...ja.frontmatter.keys])) {
    const enValue = en.frontmatter.data[key];
    const jaValue = ja.frontmatter.data[key];
    if (key === "title" || key === "description") {
      if (typeof enValue !== "string" || enValue.trim() === "") {
        diagnostics.add(`en:${relativePath}: frontmatter/${key}: value must be a nonempty string`);
      }
      if (typeof jaValue !== "string" || jaValue.trim() === "") {
        diagnostics.add(`ja:${relativePath}: frontmatter/${key}: value must be a nonempty string`);
      }
    } else if (!isDeepStrictEqual(enValue, jaValue)) {
      diagnostics.add(
        `pair:${relativePath}: frontmatter/value:${key}: EN=${JSON.stringify(enValue)} JA=${JSON.stringify(jaValue)}`,
      );
    }
  }
  for (const [rule, left, right] of [
    ["fence/raw-bytes", en.fences, ja.fences],
    ["structure/order", en.events, ja.events],
    ["literal/numeric", en.numbers, ja.numbers],
    ["literal/technical", en.technical, ja.technical],
  ]) {
    if (!isDeepStrictEqual(left, right)) {
      diagnostics.add(`pair:${relativePath}: ${rule}: ${firstDifference(left, right)}`);
    }
  }
}

export async function checkLocaleParity(options = {}) {
  const diagnostics = diagnosticSet();
  const manifest = await buildManifestInternal(options, diagnostics);
  for (const pair of manifest.pairs) {
    try {
      const [enSource, jaSource] = await Promise.all([
        readFile(pair.enPath, "utf8"),
        readFile(pair.jaPath, "utf8"),
      ]);
      compareDocuments(enSource, jaSource, pair.relativePath, diagnostics);
    } catch (error) {
      diagnostics.add(`pair:${pair.relativePath}: read: ${error.message}`);
    }
  }
  finishDiagnostics(diagnostics);
  return {
    pairs: manifest.pairs.length,
    defaultOnly: manifest.defaultOnly.length,
    sharedGenerated: manifest.sharedGenerated.length,
    manifest,
  };
}

function normalizeBase(base) {
  if (base === "" || base === "/") return "";
  const withLeading = base.startsWith("/") ? base : `/${base}`;
  return withLeading.replace(/\/+$/, "");
}

function applyRouteStyle(route, base, trailingSlash) {
  const full = `${base}${route}` || "/";
  if (!trailingSlash || full === "/" || /\.[A-Za-z]\w*$/.test(full.split("/").at(-1) ?? "")) {
    return full;
  }
  return full.endsWith("/") ? full : `${full}/`;
}

function localizedRoute(defaultRoute) {
  return `/${LOCALIZED_LOCALE}${defaultRoute}`;
}

async function collectBuiltRoutes(builtDir, base, trailingSlash, diagnostics) {
  const root = resolve(builtDir);
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    diagnostics.add(
      `routes: built/root: built directory is unavailable at ${root}: ${error.message}`,
    );
    return new Set();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    diagnostics.add(`routes: built/root: built directory must be a real directory: ${root}`);
    return new Set();
  }
  const routes = new Set();
  const normalized = new Map();
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!isInside(root, path)) {
        diagnostics.add(`routes: built/escape: ${path} escapes ${root}`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        diagnostics.add(`routes: built/symlink: ${displayPath(path, root)}`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
      let route = `/${toPosix(relative(root, path))}`;
      route = route.endsWith("/index.html")
        ? route.slice(0, -"/index.html".length) || "/"
        : route.slice(0, -".html".length);
      route = trailingSlash && route !== "/" ? `${route.replace(/\/+$/, "")}/` : route;
      const folded = route.replace(/\/+$/, "").toLocaleLowerCase("en-US") || "/";
      const previous = normalized.get(folded);
      if (previous !== undefined) {
        diagnostics.add(`routes: built/duplicate: ${previous} and ${route}`);
      } else {
        normalized.set(folded, route);
      }
      routes.add(route);
    }
  }
  await visit(root);
  if (routes.size === 0) diagnostics.add("routes: built/empty: discovered zero HTML routes");
  for (const route of routes) {
    const unstyled = route.replace(/\/+$/, "") || "/";
    const hasDocsSegment = /\/(?:ja\/)?docs(?:\/|$)/.test(unstyled);
    const withinConfiguredBase =
      base === ""
        ? unstyled === "/docs" ||
          unstyled.startsWith("/docs/") ||
          unstyled === `/${LOCALIZED_LOCALE}/docs` ||
          unstyled.startsWith(`/${LOCALIZED_LOCALE}/docs/`)
        : unstyled === `${base}/docs` ||
          unstyled.startsWith(`${base}/docs/`) ||
          unstyled === `${base}/${LOCALIZED_LOCALE}/docs` ||
          unstyled.startsWith(`${base}/${LOCALIZED_LOCALE}/docs/`);
    if (hasDocsSegment && !withinConfiguredBase) {
      diagnostics.add(`routes: built/base: route escapes configured base ${base}: ${route}`);
    }
  }
  return routes;
}

function autoIndexRoutes(relativePaths, explicitRoutes) {
  const autoIndexes = new Set();
  for (const relativePath of relativePaths) {
    const withoutExtension = relativePath.slice(0, -extname(relativePath).length);
    const segments = withoutExtension.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const route = `/docs/${segments.slice(0, depth).join("/")}`;
      if (!explicitRoutes.has(route)) autoIndexes.add(route);
    }
  }
  return autoIndexes;
}

function routeContract(manifest) {
  const pairedExplicit = new Set(manifest.pairs.map((pair) => pair.route));
  const pairedAutoIndexes = autoIndexRoutes(
    manifest.pairs.map((pair) => pair.relativePath),
    pairedExplicit,
  );
  const shared = new Set(manifest.sharedGenerated.map((page) => page.route));
  const defaultOnlyAll = new Set(manifest.defaultOnly.map((page) => page.route));
  const defaultOnlyEmitted = new Set(
    manifest.defaultOnly.filter((page) => page.emitsRoute).map((page) => page.route),
  );
  const defaultOnlyAutoIndexes = autoIndexRoutes(
    manifest.defaultOnly.map((page) => page.relativePath),
    defaultOnlyAll,
  );
  const paired = new Set([...pairedExplicit, ...pairedAutoIndexes, ...shared]);
  return {
    expectedDefault: new Set([...paired, ...defaultOnlyEmitted, ...defaultOnlyAutoIndexes]),
    expectedLocalized: new Set([...paired].map(localizedRoute)),
    paired,
    defaultOnly: new Set([...defaultOnlyEmitted, ...defaultOnlyAutoIndexes]),
    autoIndexes: pairedAutoIndexes,
  };
}

function routeWithoutStyle(route, base) {
  const withoutBase =
    base === "" ? route : route.startsWith(base) ? route.slice(base.length) || "/" : null;
  if (withoutBase === null) return null;
  return withoutBase.replace(/\/+$/, "") || "/";
}

export async function checkLocaleRoutes(options = {}) {
  const diagnostics = diagnosticSet();
  const manifest = await buildManifestInternal(options, diagnostics);
  const builtDir = resolve(options.builtDir ?? join(DOC_DIRECTORY, "dist"));
  let siteConfig = manifest.siteConfig;
  if (options.base === undefined || options.trailingSlash === undefined) {
    siteConfig ??= await loadSiteConfig(
      resolve(options.configPath ?? join(DOC_DIRECTORY, "zfb.config.ts")),
      diagnostics,
    );
  }
  const base = normalizeBase(options.base ?? siteConfig?.basePath ?? "/__invalid-base__");
  const trailingSlash = options.trailingSlash ?? siteConfig?.trailingSlash ?? false;
  const routes = await collectBuiltRoutes(builtDir, base, trailingSlash, diagnostics);
  const style = (route) => applyRouteStyle(route, base, trailingSlash);
  const contract = routeContract(manifest);
  const expectedDefault = new Set([...contract.expectedDefault].map(style));
  const expectedLocalized = new Set([...contract.expectedLocalized].map(style));
  const defaultRoutes = new Set();
  const localizedRoutes = new Set();
  for (const route of routes) {
    const raw = routeWithoutStyle(route, base);
    if (raw === null) continue;
    if (raw === "/docs" || raw.startsWith("/docs/")) defaultRoutes.add(route);
    if (raw === `/${LOCALIZED_LOCALE}/docs` || raw.startsWith(`/${LOCALIZED_LOCALE}/docs/`)) {
      localizedRoutes.add(route);
      const defaultShape = raw.slice(`/${LOCALIZED_LOCALE}`.length);
      if (DEFAULT_LOCALE_ONLY_PREFIXES.some((prefix) => isWithinPrefix(defaultShape, prefix))) {
        diagnostics.add(
          `routes: default-only/localized: JA route is forbidden under an EN-only prefix: ${route}`,
        );
      }
    }
  }
  for (const route of expectedDefault) {
    if (!defaultRoutes.has(route)) diagnostics.add(`routes: expected/en: missing ${route}`);
  }
  for (const route of expectedLocalized) {
    if (!localizedRoutes.has(route)) diagnostics.add(`routes: expected/ja: missing ${route}`);
  }
  for (const route of defaultRoutes) {
    if (!expectedDefault.has(route)) diagnostics.add(`routes: unexpected/en: ${route}`);
  }
  for (const route of localizedRoutes) {
    if (!expectedLocalized.has(route)) diagnostics.add(`routes: unexpected/ja: ${route}`);
  }

  const switchConfig = { base, defaultLocale: DEFAULT_LOCALE, trailingSlash };
  for (const route of [...contract.paired].map(style)) {
    const target = switchLocaleHref(route, switchConfig, DEFAULT_LOCALE, LOCALIZED_LOCALE);
    if (!expectedLocalized.has(target) || !localizedRoutes.has(target)) {
      diagnostics.add(`routes: switch/en-to-ja: ${route} maps to missing ${target}`);
    }
    const reverse = switchLocaleHref(target, switchConfig, LOCALIZED_LOCALE, DEFAULT_LOCALE);
    if (!expectedDefault.has(reverse) || !defaultRoutes.has(reverse)) {
      diagnostics.add(`routes: switch/ja-to-en: ${target} maps to missing ${reverse}`);
    }
    const targetWithoutBase = routeWithoutStyle(reverse, base) ?? "";
    if (!targetWithoutBase.startsWith("/docs")) {
      diagnostics.add(`routes: switch/escape: ${target} maps outside the docs base to ${reverse}`);
    }
  }
  finishDiagnostics(diagnostics);
  return {
    pairs: manifest.pairs.length,
    defaultRoutes: defaultRoutes.size,
    localizedRoutes: localizedRoutes.size,
    defaultOnlyRoutes: contract.defaultOnly.size,
    sharedGeneratedRoutes: manifest.sharedGenerated.length,
    autoIndexRoutes: contract.autoIndexes.size,
  };
}

function parseCli(argv) {
  let builtDir;
  let routesOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--routes-only") {
      routesOnly = true;
    } else if (argument === "--built-dir") {
      builtDir = argv[++index];
      if (!builtDir) throw new Error("--built-dir requires a value");
    } else if (argument.startsWith("--built-dir=")) {
      builtDir = argument.slice("--built-dir=".length);
      if (!builtDir) throw new Error("--built-dir requires a value");
    } else if (argument !== "--") {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (routesOnly && builtDir === undefined) throw new Error("--routes-only requires --built-dir");
  if (!routesOnly && builtDir !== undefined) throw new Error("--built-dir requires --routes-only");
  return { builtDir, routesOnly };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.routesOnly) {
      const summary = await checkLocaleRoutes({ builtDir: resolve(DOC_DIRECTORY, cli.builtDir) });
      console.log(
        `Locale routes OK (${summary.pairs} source pairs; ${summary.defaultRoutes} EN / ${summary.localizedRoutes} JA routes; ${summary.defaultOnlyRoutes} default-only; ${summary.sharedGeneratedRoutes} shared generated)`,
      );
    } else {
      const summary = await checkLocaleParity();
      console.log(
        `Locale source parity OK (${summary.pairs} EN/JA pairs; ${summary.defaultOnly} default-only generated; ${summary.sharedGenerated} shared generated)`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export const __test = Object.freeze({
  compareDocuments,
  extractDocument,
  routeContract,
  sourceRoute,
});
