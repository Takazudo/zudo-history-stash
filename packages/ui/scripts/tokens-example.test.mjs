import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

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

test("keeps the framework-independent token example in exact semantic lockstep", async () => {
  const [example, viewer] = await Promise.all([
    readFile(resolve(packageRoot, "styles/tokens.example.css"), "utf8"),
    readFile(resolve(repositoryRoot, "workers/viewer/src/styles/tokens.css"), "utf8"),
  ]);

  assert.equal(
    example,
    transformViewerTokensToExample(viewer),
    "Regenerate packages/ui/styles/tokens.example.css from the Viewer token source transformation",
  );
  assert.doesNotMatch(example, /@(?:import|layer|theme)\b/u);
  assert.match(example, /^:root \{/u);
});
