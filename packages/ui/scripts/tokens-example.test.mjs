import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

const themeActivationSuffix = [
  "/* No stored preference is intentionally dark. Explicit system mode follows the OS. */",
  ":root {",
  "  color-scheme: dark;",
  "}",
  "",
  ':root[data-theme="system"],',
  ':root[data-theme="dark"] {',
  "  color-scheme: dark;",
  "}",
  "",
  ':root[data-theme="light"] {',
  "  color-scheme: light;",
  "}",
  "",
  "@media (prefers-color-scheme: light) {",
  '  :root[data-theme="system"] {',
  "    color-scheme: light;",
  "  }",
  "}",
  "",
].join("\n");

function transformViewerTokensToExample(source) {
  const prefix =
    "@layer base, zhs-components, utilities;\n\n" +
    '@import "tailwindcss/preflight" layer(base);\n' +
    '@import "tailwindcss/utilities" layer(utilities);\n\n';
  if (!source.startsWith(prefix)) {
    throw new Error("Viewer token source prefix changed; update the explicit token transformation");
  }

  const withoutPrefix = source.slice(prefix.length);
  const themeMatch = withoutPrefix.match(/^@theme \{([\s\S]*?)\n\}\n\n/u);
  if (!themeMatch) {
    throw new Error("Viewer token source must contain exactly one transformable @theme block");
  }
  const rest = withoutPrefix.slice(themeMatch[0].length);
  if (rest !== themeActivationSuffix) {
    throw new Error(
      "Viewer token source theme activation suffix changed; update the explicit token transformation",
    );
  }
  const transformed = `:root {${themeMatch[1]}\n}\n\n${rest}`;
  if (/^\s*@(?:import|layer|theme)\b/mu.test(transformed)) {
    throw new Error("The transformed token example must not contain Tailwind directives");
  }
  const unsupportedAtRules = [...transformed.matchAll(/^\s*@([\w-]+)/gmu)].filter(
    ([, name]) => name !== "media",
  );
  if (unsupportedAtRules.length > 0) {
    throw new Error(
      `Unsupported at-rule in transformed token example: @${unsupportedAtRules[0][1]}`,
    );
  }
  return transformed;
}

async function readTokenSources() {
  return Promise.all([
    readFile(resolve(packageRoot, "styles/tokens.example.css"), "utf8"),
    readFile(resolve(repositoryRoot, "workers/viewer/src/styles/tokens.css"), "utf8"),
  ]);
}

test("keeps the framework-independent token example in exact semantic lockstep", async () => {
  const [example, viewer] = await readTokenSources();

  assert.equal(
    example,
    transformViewerTokensToExample(viewer),
    "Regenerate packages/ui/styles/tokens.example.css from the Viewer token source transformation",
  );
  assert.doesNotMatch(example, /@(?:import|layer|theme)\b/u);
  assert.match(example, /^:root \{/u);
});

test("rejects appended or altered global CSS in the Viewer suffix", async () => {
  const [, viewer] = await readTokenSources();

  assert.throws(
    () => transformViewerTokensToExample(`${viewer}\n* { margin: 0; }\n`),
    /theme activation suffix changed/u,
  );

  const alteredSelector = viewer.replace(
    ':root[data-theme="light"] {',
    ':root[data-theme="light"],\n:root[data-theme="dim"] {',
  );
  assert.notEqual(alteredSelector, viewer);
  assert.throws(
    () => transformViewerTokensToExample(alteredSelector),
    /theme activation suffix changed/u,
  );
});
