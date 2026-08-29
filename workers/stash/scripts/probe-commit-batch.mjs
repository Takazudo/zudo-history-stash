import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const port = Number.parseInt(process.env.COMMIT_BATCH_PROBE_PORT ?? "8798", 10);
const remote = process.env.COMMIT_BATCH_PROBE_REMOTE === "1";
const documentedQueryLimit = Number.parseInt(process.env.COMMIT_BATCH_PROBE_QUERY_LIMIT ?? "0", 10);
const configuredPath = process.env.COMMIT_BATCH_PROBE_WRANGLER_CONFIG ?? "wrangler.toml";
const configPath = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);

if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("COMMIT_BATCH_PROBE_PORT must be a safe, non-privileged TCP port");
}
if (![0, 50, 1_000].includes(documentedQueryLimit)) {
  throw new Error("COMMIT_BATCH_PROBE_QUERY_LIMIT must be 50, 1000, or omitted");
}
if (remote && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) {
  throw new Error(
    "Remote mode requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for a disposable D1 database",
  );
}

const directory = await mkdtemp(resolve(tmpdir(), "zhs-commit-batch-probe-"));
const workerPath = resolve(directory, "worker.mjs");
const workerSource = String.raw`
import { DurableObject } from "cloudflare:workers";

const BODY_COUNT = 20;
const BODY_BYTES = 250_000;

// The repository config binds this class; the D1-only probe never instantiates it.
export class StashEvents extends DurableObject {}

async function cleanup(db) {
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS commit_batch_live_probe_payloads"),
    db.prepare("DROP TABLE IF EXISTS commit_batch_live_probe_marks"),
    db.prepare("DROP TABLE IF EXISTS commit_batch_live_probe_commits"),
  ]);
}

export default {
  async fetch(_request, env) {
    let cleanupError = null;
    try {
      await cleanup(env.DB);
      await env.DB.batch([
        env.DB.prepare("CREATE TABLE commit_batch_live_probe_commits (id INTEGER PRIMARY KEY, entry_count INTEGER NOT NULL, change_count INTEGER NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, CHECK (sealed = 0 OR entry_count = change_count))"),
        env.DB.prepare("CREATE TABLE commit_batch_live_probe_payloads (id INTEGER PRIMARY KEY, commit_id INTEGER NOT NULL, body TEXT NOT NULL)"),
        env.DB.prepare("CREATE TABLE commit_batch_live_probe_marks (id INTEGER PRIMARY KEY, commit_id INTEGER NOT NULL)"),
      ]);

      const body = "x".repeat(BODY_BYTES);
      const statements = [
        env.DB.prepare("INSERT INTO commit_batch_live_probe_commits (id, entry_count, change_count) VALUES (1, 20, 0)"),
      ];
      for (let index = 1; index <= BODY_COUNT; index += 1) {
        statements.push(
          env.DB.prepare("INSERT INTO commit_batch_live_probe_payloads (id, commit_id, body) VALUES (?, 1, ?)").bind(index, body),
          env.DB.prepare("INSERT INTO commit_batch_live_probe_marks (id, commit_id) VALUES (?, 1)").bind(index * 2 - 1),
          env.DB.prepare("INSERT INTO commit_batch_live_probe_marks (id, commit_id) VALUES (?, 1)").bind(index * 2),
        );
      }
      statements.push(
        env.DB.prepare("UPDATE commit_batch_live_probe_commits SET change_count = 20, sealed = 1 WHERE id = 1"),
      );
      const started = performance.now();
      const results = await env.DB.batch(statements);
      return Response.json({
        ok: true,
        statements: statements.length,
        statementResults: results.length,
        boundBodyBytes: BODY_COUNT * BODY_BYTES,
        elapsedMs: Math.round(performance.now() - started),
        changes: results.map((result) => result.meta.changes),
      });
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      try {
        await cleanup(env.DB);
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError !== null) console.error("commit batch probe cleanup failed", cleanupError);
    }
  },
};
`;

await writeFile(workerPath, workerSource, { encoding: "utf8", mode: 0o600 });

const args = [
  "exec",
  "wrangler",
  "dev",
  workerPath,
  "--config",
  configPath,
  "--port",
  String(port),
  remote ? "--remote" : "--local",
  "--show-interactive-dev-session=false",
  "--log-level=error",
];
const child = spawn("pnpm", args, {
  cwd: resolve(import.meta.dirname, ".."),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8_000);
  });
}

const childExit = new Promise((resolveExit) => {
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});

async function waitForProbe() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(30_000) });
    } catch {
      const exited = await Promise.race([
        childExit,
        new Promise((resolveWait) => setTimeout(() => resolveWait(null), 250)),
      ]);
      if (exited !== null) {
        throw new Error(`Probe Worker exited before it was ready (${JSON.stringify(exited)})`);
      }
    }
  }
  throw new Error(
    `Timed out waiting for the probe Worker${diagnostics.trim() ? `:\n${diagnostics.trim()}` : ""}`,
  );
}

try {
  const response = await waitForProbe();
  const result = await response.json();
  const limitAssessment =
    documentedQueryLimit === 0
      ? "query limit not supplied; result alone does not distinguish per-call from per-statement accounting"
      : result.ok && documentedQueryLimit < result.statements
        ? "batch succeeded beyond the supplied query limit; statements did not each consume that limit"
        : !result.ok && documentedQueryLimit < 62
          ? "batch failed beyond the supplied query limit; result is consistent with per-statement accounting"
          : "batch fits the supplied query limit; success is compatible with per-statement accounting";
  console.log(
    JSON.stringify(
      {
        mode: remote ? "remote D1" : "local workerd D1",
        documentedQueryLimit: documentedQueryLimit || null,
        limitAssessment,
        ...result,
      },
      null,
      2,
    ),
  );
  if (!response.ok || !result.ok) process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([childExit, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
  if (process.exitCode && diagnostics.trim()) console.error(diagnostics.trim());
}
