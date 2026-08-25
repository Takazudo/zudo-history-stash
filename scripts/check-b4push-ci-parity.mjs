import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const b4push = readFileSync(resolve(root, "scripts/run-b4push.sh"), "utf8");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

const b4pushCommands = Array.from(b4push.matchAll(/^run_step\s+"[^"]+"\s+(.+)$/gm), ([, command]) =>
  command.trim(),
);
// Package publint/attw checks are an intentional CI-only extension; compare the shared prefix.
const quality = ci.match(
  /^\x20{2}quality:[\s\S]*?(?=^\x20{6}- name: publint and attw package checks)/m,
)?.[0];
if (quality === undefined) throw new Error("Could not find the CI quality job.");
const ciCommands = Array.from(quality.matchAll(/^\s+run:\s+(pnpm [^\n]+)$/gm), ([, command]) =>
  command.trim(),
);

if (b4pushCommands.length === 0 || ciCommands.length === 0) {
  throw new Error("Could not find the b4push or CI quality command sequence.");
}
if (b4pushCommands.join("\n") !== ciCommands.join("\n")) {
  console.error("b4push and CI quality commands have drifted:");
  console.error(`b4push:\n${b4pushCommands.join("\n")}`);
  console.error(`CI:\n${ciCommands.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`b4push/CI parity OK (${b4pushCommands.length} commands)`);
}
