import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const packageJsonPath = join(packageRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const rawArguments = process.argv.slice(2);
const packageArguments = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const [tarballArgument, ...unexpectedArguments] = packageArguments;

if (unexpectedArguments.length > 0) {
  throw new Error(`Usage: node scripts/release/package-check.mjs [--] [packed-tarball]`);
}

let temporaryDirectory;
let tarballPath;

try {
  if (tarballArgument) {
    tarballPath = resolve(packageRoot, tarballArgument);
    if (!tarballPath.endsWith(".tgz") || !statSync(tarballPath).isFile()) {
      throw new Error(`Packed tarball does not exist: ${tarballArgument}`);
    }
  } else {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "zudo-history-stash-package-check-"));
    execFileSync("pnpm", ["pack", "--pack-destination", temporaryDirectory], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    const tarballs = readdirSync(temporaryDirectory).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(
        `Expected exactly one packed tarball in ${temporaryDirectory}; found ${tarballs.length}`,
      );
    }
    tarballPath = join(temporaryDirectory, tarballs[0]);
  }

  console.log(`Running pinned package checks for ${packageJson.name} on ${basename(tarballPath)}.`);
  execFileSync("pnpm", ["dlx", "publint@0.3.12", "run", tarballPath, "--pack=false"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  const attwArguments = [
    "dlx",
    "@arethetypeswrong/cli@0.18.5",
    tarballPath,
    "--profile",
    "esm-only",
  ];
  if (packageJson.exports?.["./styles.css"]) {
    attwArguments.push("--exclude-entrypoints", "./styles.css");
  }
  execFileSync("pnpm", attwArguments, { cwd: packageRoot, stdio: "inherit" });
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}
