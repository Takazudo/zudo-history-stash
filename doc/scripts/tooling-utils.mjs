import { readFile } from "node:fs/promises";

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function yamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function yamlKey(raw) {
  return yamlScalar(raw.replace(/:\s*$/, ""));
}

export function parseLockImporter(source, importerName) {
  const lines = source.split(/\r?\n/);
  const importersLine = lines.findIndex((line) => line === "importers:");
  if (importersLine === -1) throw new Error("pnpm lockfile has no importers section");

  let start = -1;
  let end = lines.length;
  for (let index = importersLine + 1; index < lines.length; index += 1) {
    const match = /^  (\S.*):\s*$/.exec(lines[index]);
    if (match === null) continue;
    const name = yamlKey(`${match[1]}:`);
    if (start !== -1) {
      end = index;
      break;
    }
    if (name === importerName) start = index + 1;
  }
  if (start === -1) throw new Error(`pnpm lockfile has no ${importerName} importer`);

  const result = new Map();
  let group = null;
  let dependency = null;
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    const groupMatch = /^    ([A-Za-z][A-Za-z]+):\s*$/.exec(line);
    if (groupMatch !== null) {
      group = groupMatch[1];
      dependency = null;
      continue;
    }
    const dependencyMatch = /^      (.+):\s*$/.exec(line);
    if (dependencyMatch !== null && group !== null) {
      dependency = yamlKey(`${dependencyMatch[1]}:`);
      if (result.has(dependency)) {
        throw new Error(`pnpm ${importerName} importer declares ${dependency} more than once`);
      }
      result.set(dependency, { group });
      continue;
    }
    const fieldMatch = /^        (specifier|version):\s*(.+?)\s*$/.exec(line);
    if (fieldMatch !== null && dependency !== null) {
      const record = result.get(dependency);
      if (record[fieldMatch[1]] !== undefined) {
        throw new Error(`pnpm ${importerName} importer repeats ${dependency}.${fieldMatch[1]}`);
      }
      record[fieldMatch[1]] = yamlScalar(fieldMatch[2]);
    }
  }
  return result;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export function directDependency(manifest, name, label) {
  const matches = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.hasOwn(manifest[field] ?? {}, name) ? [{ field, value: manifest[field][name] }] : [],
  );
  if (matches.length === 0) throw new Error(`${label} does not directly declare ${name}`);
  if (matches.length !== 1)
    throw new Error(`${label} declares ${name} in multiple dependency fields`);
  return matches[0];
}

export function assertExactVersion(value, label) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must be an exact version, received ${JSON.stringify(value)}`);
  }
  return value;
}

export function lockResolutionCore(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  const peerSuffix = value.indexOf("(");
  return peerSuffix === -1 ? value : value.slice(0, peerSuffix);
}

export function assertLockedDependency(importer, name, expected, label) {
  const entry = importer.get(name);
  if (entry === undefined) throw new Error(`${label} lock importer does not declare ${name}`);
  if (entry.specifier !== expected) {
    throw new Error(
      `${label} lock importer ${name} specifier must be ${expected}, received ${entry.specifier}`,
    );
  }
  const core = lockResolutionCore(entry.version);
  if (core !== expected) {
    throw new Error(
      `${label} lock importer ${name} resolution must be ${expected}, received ${entry.version}`,
    );
  }
}
