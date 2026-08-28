import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const docRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function runnerFixture(t, buildFails, cleanupFails = false) {
  const root = await mkdtemp(join(tmpdir(), "zhs-doc-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "doc/scripts"), { recursive: true });
  await mkdir(join(root, "bin"));
  await cp(join(docRoot, "scripts/run-b4push.sh"), join(root, "doc/scripts/run-b4push.sh"));
  const fakePnpm = join(root, "bin/pnpm");
  await writeFile(
    fakePnpm,
    [
      "#!/usr/bin/env bash",
      'printf "%s|%s\\n" "$PWD" "$*" >> "$DOC_GATE_LOG"',
      'if [[ "$PWD" == */doc && "$1" == "build" ]]; then',
      buildFails
        ? "  exit 23"
        : '  mkdir -p "$PWD/dist"; printf "fresh\\n" > "$PWD/dist/index.html"',
      "fi",
      "exit 0",
    ].join("\n"),
  );
  await chmod(fakePnpm, 0o755);
  if (cleanupFails) {
    const fakeRm = join(root, "bin/rm");
    await writeFile(fakeRm, ["#!/usr/bin/env bash", "exit 24"].join("\n"));
    await chmod(fakeRm, 0o755);
  }
  return root;
}

test("Docs runner declares the exact ordered 13-step contract and no step 14", async () => {
  const source = await readFile(join(docRoot, "scripts/run-b4push.sh"), "utf8");
  const labels = [
    "Build libraries",
    "Markdown format check",
    "Template drift",
    "Pin parity",
    "Wrangler pin",
    "Contract parity",
    "Version wiring",
    "Checked examples",
    "Locale parity",
    "zfb check",
    "Fresh Docs build",
    "HTML validation",
    "Link validation",
  ];
  let previous = -1;
  for (const [index, label] of labels.entries()) {
    const position = source.indexOf(`Step ${index + 1}/13: ${label}`);
    assert.ok(position > previous, `missing or reordered step ${index + 1}: ${label}`);
    previous = position;
  }
  assert.doesNotMatch(source, /Step 14|check:changelog-drift/);
  assert.match(source, /SKIP: authoritative Docs build failed/);
});

test("Docs runner executes one successful ordered pass", async (t) => {
  const root = await runnerFixture(t, false);
  const log = join(root, "calls.log");
  const result = await run("bash", [join(root, "doc/scripts/run-b4push.sh")], {
    cwd: join(root, "doc"),
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      DOC_GATE_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const commands = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split("|")[1]);
  assert.deepEqual(commands, [
    "build:libs",
    "format:md:check",
    "check:template-drift",
    "check:pin-parity",
    "check:wrangler-pin",
    "check:contract",
    "check:versions",
    "check:examples",
    "check:locale-parity",
    "check",
    "build",
    "check:html",
    "check:links",
  ]);
  assert.match(result.stdout, /All 13 Docs checks passed/);
});

test("a failed build removes stale dist and cannot run downstream validators", async (t) => {
  const root = await runnerFixture(t, true);
  await mkdir(join(root, "doc/dist"));
  await writeFile(join(root, "doc/dist/stale-sentinel.html"), "STALE_SENTINEL\n");
  const log = join(root, "calls.log");
  const result = await run("bash", [join(root, "doc/scripts/run-b4push.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      DOC_GATE_LOG: log,
    },
  });
  assert.equal(result.status, 1);
  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /check:html|check:links/);
  await assert.rejects(readFile(join(root, "doc/dist/stale-sentinel.html")), /ENOENT/);
  assert.match(result.stdout, /SKIP: authoritative Docs build failed/);
  assert.match(result.stdout, /Step 12\/13: HTML validation \(build prerequisite failed\)/);
  assert.match(result.stdout, /Step 13\/13: Link validation \(build prerequisite failed\)/);
});

test("failed stale-dist cleanup refuses the build and both downstream validators", async (t) => {
  const root = await runnerFixture(t, false, true);
  await mkdir(join(root, "doc/dist"));
  await writeFile(join(root, "doc/dist/stale-sentinel.html"), "STALE_SENTINEL\n");
  const log = join(root, "calls.log");
  const result = await run("bash", [join(root, "doc/scripts/run-b4push.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
      DOC_GATE_LOG: log,
    },
  });
  assert.equal(result.status, 1);
  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /\|(?:build|check:html|check:links)(?:\n|$)/);
  assert.equal(
    await readFile(join(root, "doc/dist/stale-sentinel.html"), "utf8"),
    "STALE_SENTINEL\n",
  );
  assert.match(result.stdout, /refusing to build or validate stale output/);
  assert.match(result.stdout, /Fresh Docs build \(stale dist cleanup failed\)/);
  assert.match(result.stdout, /Step 12\/13: HTML validation \(build prerequisite failed\)/);
  assert.match(result.stdout, /Step 13\/13: Link validation \(build prerequisite failed\)/);
});
