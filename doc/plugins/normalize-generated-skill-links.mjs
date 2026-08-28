import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { definePlugin } from "@takazudo/zfb/plugins";

const DEFAULT_OPTIONS = {
  generatedSkillsDir: "src/content/docs/claude-skills",
  sourceSkillsDir: "../.claude/skills",
  repositoryRoot: "..",
  branch: "main",
};

function requiredString(options, name, fallback) {
  const value = options[name] ?? fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`normalize-generated-skill-links: ${name} must be a non-empty string`);
  }
  return value;
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function splitSuffix(destination) {
  const queryAt = destination.indexOf("?");
  const hashAt = destination.indexOf("#");
  const indexes = [queryAt, hashAt].filter((index) => index >= 0);
  const suffixAt = indexes.length === 0 ? -1 : Math.min(...indexes);
  return suffixAt === -1
    ? { path: destination, suffix: "" }
    : { path: destination.slice(0, suffixAt), suffix: destination.slice(suffixAt) };
}

function encodeRepositoryPath(path) {
  return path.split(sep).map(encodeURIComponent).join("/");
}

function createDestinationNormalizer({ sourceSkillDir, repositoryRoot, repositoryUrl, branch }) {
  const repositoryReal = realpathSync(repositoryRoot);
  const baseUrl = repositoryUrl.replace(/\/+$/, "");

  return (rawDestination) => {
    const bracketed = rawDestination.startsWith("<") && rawDestination.endsWith(">");
    const destination = bracketed ? rawDestination.slice(1, -1) : rawDestination;
    if (
      destination === "" ||
      destination.startsWith("#") ||
      destination.startsWith("/") ||
      destination.startsWith("//") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) ||
      /^\.\/(?:ref|script|asset)-[^?#]+(?:[?#].*)?$/.test(destination)
    ) {
      return rawDestination;
    }

    const { path, suffix } = splitSuffix(destination);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      return rawDestination;
    }

    const target = resolve(sourceSkillDir, decodedPath);
    if (!existsSync(target)) return rawDestination;

    let targetReal;
    let targetStat;
    try {
      targetReal = realpathSync(target);
      targetStat = statSync(targetReal);
    } catch {
      return rawDestination;
    }
    if (!isInside(repositoryReal, targetReal)) return rawDestination;

    const repositoryPath = relative(repositoryRoot, target);
    if (
      repositoryPath === ".." ||
      repositoryPath.startsWith(`..${sep}`) ||
      isAbsolute(repositoryPath)
    ) {
      return rawDestination;
    }
    const view = targetStat.isDirectory() ? "tree" : targetStat.isFile() ? "blob" : null;
    if (view === null) return rawDestination;

    return `${baseUrl}/${view}/${encodeURIComponent(branch)}/${encodeRepositoryPath(repositoryPath)}${suffix}`;
  };
}

function rewriteInlineLinks(line, normalizeDestination) {
  const codeSpans = [];
  const masked = line.replace(/(`+)([^`\n]*?)\1/g, (span) => {
    const token = `\u0000ZHS_INLINE_${codeSpans.length}\u0000`;
    codeSpans.push(span);
    return token;
  });

  const linkPattern =
    /(\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)\n]+)(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?(\s*\))/g;
  const rewritten = masked.replace(
    linkPattern,
    (match, prefix, destination, title = "", close, offset, wholeLine) => {
      if (offset > 0 && wholeLine[offset - 1] === "!") return match;
      return `${prefix}${normalizeDestination(destination)}${title}${close}`;
    },
  );

  return rewritten.replace(/\u0000ZHS_INLINE_(\d+)\u0000/g, (_match, index) => codeSpans[index]);
}

export function rewriteGeneratedSkillLinks(markdown, normalizeDestination) {
  let fence = null;
  let linksChanged = 0;
  const output = markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1];
        if (fence === null) fence = { character: marker[0], length: marker.length };
        else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return rewriteInlineLinks(line, (destination) => {
        const next = normalizeDestination(destination);
        if (next !== destination) linksChanged += 1;
        return next;
      });
    })
    .join("");
  return { markdown: output, linksChanged };
}

export function normalizeGeneratedSkillLinks(projectRoot, rawOptions = {}) {
  const generatedSkillsDir = resolve(
    projectRoot,
    requiredString(rawOptions, "generatedSkillsDir", DEFAULT_OPTIONS.generatedSkillsDir),
  );
  const sourceSkillsDir = resolve(
    projectRoot,
    requiredString(rawOptions, "sourceSkillsDir", DEFAULT_OPTIONS.sourceSkillsDir),
  );
  const repositoryRoot = resolve(
    projectRoot,
    requiredString(rawOptions, "repositoryRoot", DEFAULT_OPTIONS.repositoryRoot),
  );
  const repositoryUrl = requiredString(rawOptions, "repositoryUrl");
  const branch = requiredString(rawOptions, "branch", DEFAULT_OPTIONS.branch);

  if (!existsSync(generatedSkillsDir)) return { filesChanged: 0, linksChanged: 0 };

  let filesChanged = 0;
  let linksChanged = 0;
  const entries = readdirSync(generatedSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const generatedFile = resolve(generatedSkillsDir, entry.name, "index.mdx");
    const sourceSkillFile = resolve(sourceSkillsDir, entry.name, "SKILL.md");
    if (!existsSync(generatedFile) || !existsSync(sourceSkillFile)) continue;

    const source = readFileSync(generatedFile, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (frontmatter === undefined || !/^generated:\s*true\s*$/m.test(frontmatter)) continue;

    const normalizeDestination = createDestinationNormalizer({
      sourceSkillDir: resolve(sourceSkillFile, ".."),
      repositoryRoot,
      repositoryUrl,
      branch,
    });
    const rewritten = rewriteGeneratedSkillLinks(source, normalizeDestination);
    if (rewritten.markdown === source) continue;
    writeFileSync(generatedFile, rewritten.markdown);
    filesChanged += 1;
    linksChanged += rewritten.linksChanged;
  }

  return { filesChanged, linksChanged };
}

export default definePlugin({
  name: "normalize-generated-skill-links",
  preBuild({ projectRoot, options, logger }) {
    const result = normalizeGeneratedSkillLinks(projectRoot, options);
    if (result.filesChanged > 0) {
      logger.info(
        `normalized ${result.linksChanged} repository link(s) in ${result.filesChanged} generated skill page(s)`,
      );
    }
  },
});
