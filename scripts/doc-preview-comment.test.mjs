import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  DOC_PREVIEW_COMMENT_MARKER,
  MAX_WRANGLER_OUTPUT_BYTES,
  MAX_WRANGLER_OUTPUT_LINES,
  renderDocPreviewComment,
  runGh,
  upsertDocPreviewComment,
} from "./doc-preview-comment.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const ALIAS_URL = "https://pr-170-zudo-history-stash-docs.team-preview.workers.dev";
const VERSION_URL = "https://0123456789abcdef-zudo-history-stash-docs.team-preview.workers.dev";
const INPUT = {
  expectedSha: SHA,
  pr: "170",
  repository: "Takazudo/zudo-history-stash",
  sha: SHA,
};

function versionUpload(overrides = {}) {
  return {
    type: "version-upload",
    version: 1,
    worker_name: "zudo-history-stash-docs",
    version_id: "version-0123456789abcdef",
    preview_url: VERSION_URL,
    preview_alias_url: ALIAS_URL,
    wrangler_environment: null,
    worker_name_overridden: false,
    ...overrides,
  };
}

function validNdjson(overrides = {}) {
  return [
    JSON.stringify({ type: "wrangler-session", version: 1 }),
    JSON.stringify(versionUpload(overrides)),
    "",
  ].join("\n");
}

async function outputFixture(contents = validNdjson()) {
  const directory = await mkdtemp(join(tmpdir(), "zhs-doc-preview-comment-"));
  const outputPath = join(directory, "wrangler.ndjson");
  await writeFile(outputPath, contents);
  return {
    directory,
    input: { ...INPUT, outputPath },
    outputPath,
  };
}

async function removed(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

async function dispose(fixture) {
  await rm(fixture.directory, { force: true, recursive: true });
}

function ghFixture(responses) {
  const calls = [];
  const remaining = [...responses];
  const gh = async (args, options = {}) => {
    calls.push({ args, options });
    assert.notEqual(remaining.length, 0, `Unexpected gh call: ${args.join(" ")}`);
    const response = remaining.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, gh, remaining };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("documentation preview comment", () => {
  it("renders the exact marker, validated alias, full SHA, and public warning", () => {
    const body = renderDocPreviewComment({ aliasUrl: ALIAS_URL, sha: SHA });
    assert.equal(body.split("\n")[0], DOC_PREVIEW_COMMENT_MARKER);
    assert.match(body, new RegExp(ALIAS_URL, "u"));
    assert.match(body, new RegExp(SHA, "u"));
    assert.match(body, /public/u);
    assert.doesNotMatch(body, /version-0123456789abcdef/u);
    assert.doesNotMatch(body, new RegExp(VERSION_URL, "u"));
  });

  it("creates one bot comment with JSON only on stdin and removes structured output", async () => {
    const output = await outputFixture();
    const fixture = ghFixture([JSON.stringify([[]]), "created response is discarded"]);
    try {
      assert.deepEqual(await upsertDocPreviewComment(output.input, { gh: fixture.gh }), {
        action: "created",
        commentId: null,
      });
      assert.deepEqual(fixture.calls[0].args.slice(0, 6), [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        "-H",
      ]);
      assert.match(fixture.calls[0].args.at(-1), /comments\?per_page=100$/u);
      assert.deepEqual(fixture.calls[1].args.slice(0, 3), ["api", "--method", "POST"]);
      assert.deepEqual(JSON.parse(fixture.calls[1].options.input), {
        body: renderDocPreviewComment({ aliasUrl: ALIAS_URL, sha: SHA }),
      });
      const allArgs = fixture.calls.flatMap((call) => call.args).join(" ");
      assert.equal(allArgs.includes(ALIAS_URL), false);
      assert.equal(allArgs.includes(SHA), false);
      assert.equal(allArgs.includes("version-0123456789abcdef"), false);
      assert.deepEqual(fixture.remaining, []);
      await removed(output.outputPath);
    } finally {
      await dispose(output);
    }
  });

  it("updates the exact bot marker found on a later page", async () => {
    const output = await outputFixture();
    const fixture = ghFixture([
      JSON.stringify([
        [{ id: 1, body: DOC_PREVIEW_COMMENT_MARKER, user: { login: "human" } }],
        [
          {
            id: 42,
            body: `${DOC_PREVIEW_COMMENT_MARKER}\nold`,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
      "updated",
    ]);
    try {
      assert.deepEqual(await upsertDocPreviewComment(output.input, { gh: fixture.gh }), {
        action: "updated",
        commentId: 42,
      });
      assert.deepEqual(fixture.calls[1].args.slice(0, 3), ["api", "--method", "PATCH"]);
      assert.equal(
        fixture.calls[1].args.at(-1),
        "repos/Takazudo/zudo-history-stash/issues/comments/42",
      );
      await removed(output.outputPath);
    } finally {
      await dispose(output);
    }
  });

  it("ignores user-owned and inexact markers when creating", async () => {
    const output = await outputFixture();
    const fixture = ghFixture([
      JSON.stringify([
        [
          { id: 1, body: DOC_PREVIEW_COMMENT_MARKER, user: { login: "human" } },
          {
            id: 2,
            body: `prefix ${DOC_PREVIEW_COMMENT_MARKER}`,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
      "created",
    ]);
    try {
      assert.deepEqual(await upsertDocPreviewComment(output.input, { gh: fixture.gh }), {
        action: "created",
        commentId: null,
      });
      await removed(output.outputPath);
    } finally {
      await dispose(output);
    }
  });

  it("rejects duplicate bot-owned markers before mutation and removes output", async () => {
    const output = await outputFixture();
    const fixture = ghFixture([
      JSON.stringify([
        [
          { id: 1, body: DOC_PREVIEW_COMMENT_MARKER, user: { login: "github-actions[bot]" } },
          {
            id: 2,
            body: `${DOC_PREVIEW_COMMENT_MARKER}\nold`,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
    ]);
    try {
      await assert.rejects(
        upsertDocPreviewComment(output.input, { gh: fixture.gh }),
        /Multiple bot-owned documentation preview comments/u,
      );
      assert.equal(fixture.calls.length, 1);
      await removed(output.outputPath);
    } finally {
      await dispose(output);
    }
  });

  it("fails closed on malformed, failed, missing, ambiguous, or unbounded NDJSON", async () => {
    const cases = [
      ["malformed JSON", "not-json\n", /malformed JSON/u],
      ["non-object record", "[]\n", /malformed record/u],
      [
        "command failure",
        `${validNdjson()}${JSON.stringify({ type: "command-failed", version: 1 })}\n`,
        /failed command/u,
      ],
      [
        "no upload",
        `${JSON.stringify({ type: "wrangler-session", version: 1 })}\n`,
        /exactly one/u,
      ],
      ["multiple uploads", `${validNdjson()}${JSON.stringify(versionUpload())}\n`, /exactly one/u],
      [
        "oversized output",
        Buffer.alloc(MAX_WRANGLER_OUTPUT_BYTES + 1, "x"),
        /bounded regular file/u,
      ],
      [
        "too many lines",
        Array.from({ length: MAX_WRANGLER_OUTPUT_LINES + 1 }, () =>
          JSON.stringify({ type: "wrangler-session" }),
        ).join("\n"),
        /line limit/u,
      ],
    ];

    for (const [name, contents, pattern] of cases) {
      const output = await outputFixture(contents);
      const fixture = ghFixture([]);
      try {
        await assert.rejects(
          upsertDocPreviewComment(output.input, { gh: fixture.gh }),
          pattern,
          name,
        );
        assert.equal(fixture.calls.length, 0, name);
        await removed(output.outputPath);
      } finally {
        await dispose(output);
      }
    }
  });

  it("rejects every wrong version-upload identity and removes output", async () => {
    const cases = [
      ["record version", { version: 2 }, /unsupported version/u],
      ["Worker", { worker_name: "zudo-history-stash" }, /wrong Worker/u],
      ["name override", { worker_name_overridden: true }, /must not override/u],
      ["environment", { wrangler_environment: "preview" }, /must not select/u],
      ["empty version ID", { version_id: "" }, /missing a version ID/u],
      ["missing alias", { preview_alias_url: undefined }, /preview_alias_url is required/u],
      ["missing preview", { preview_url: undefined }, /preview_url is required/u],
      [
        "wrong PR",
        { preview_alias_url: ALIAS_URL.replace("pr-170-", "pr-171-") },
        /does not match/u,
      ],
      [
        "wrong Worker host",
        { preview_alias_url: ALIAS_URL.replace("zudo-history-stash-docs", "other-docs") },
        /does not match/u,
      ],
      ["HTTP scheme", { preview_alias_url: ALIAS_URL.replace("https:", "http:") }, /exact HTTPS/u],
      [
        "userinfo",
        { preview_alias_url: ALIAS_URL.replace("https://", "https://user@example@") },
        /exact HTTPS/u,
      ],
      [
        "port",
        { preview_alias_url: ALIAS_URL.replace(".workers.dev", ".workers.dev:8443") },
        /exact HTTPS/u,
      ],
      ["path", { preview_alias_url: `${ALIAS_URL}/path` }, /exact HTTPS/u],
      ["query", { preview_alias_url: `${ALIAS_URL}?value=1` }, /exact HTTPS/u],
      ["fragment", { preview_alias_url: `${ALIAS_URL}#value` }, /exact HTTPS/u],
      [
        "malformed subdomain",
        { preview_alias_url: ALIAS_URL.replace("team-preview", "-team") },
        /does not match/u,
      ],
      [
        "multiple subdomain labels",
        { preview_alias_url: ALIAS_URL.replace("team-preview", "team.preview") },
        /does not match/u,
      ],
      ["per-version URL", { preview_alias_url: VERSION_URL }, /per-version preview URL/u],
      ["alias copied from preview", { preview_url: ALIAS_URL }, /must not be the per-version/u],
    ];

    for (const [name, overrides, pattern] of cases) {
      const output = await outputFixture(validNdjson(overrides));
      const fixture = ghFixture([]);
      try {
        await assert.rejects(
          upsertDocPreviewComment(output.input, { gh: fixture.gh }),
          pattern,
          name,
        );
        assert.equal(fixture.calls.length, 0, name);
        await removed(output.outputPath);
      } finally {
        await dispose(output);
      }
    }
  });

  it("rejects a checked-out SHA mismatch before comment mutation and removes output", async () => {
    const output = await outputFixture();
    const fixture = ghFixture([]);
    try {
      await assert.rejects(
        upsertDocPreviewComment(
          { ...output.input, expectedSha: "abcdef0123456789abcdef0123456789abcdef01" },
          { gh: fixture.gh },
        ),
        /does not match/u,
      );
      assert.equal(fixture.calls.length, 0);
      await removed(output.outputPath);
    } finally {
      await dispose(output);
    }
  });

  it("removes output after list, malformed-list, and comment mutation failures", async () => {
    const cases = [
      ["list", [new Error("secret list failure")], /secret list failure/u],
      ["malformed list", ["not-json"], /malformed comment JSON/u],
      [
        "mutation",
        [JSON.stringify([[]]), new Error("secret mutation failure")],
        /secret mutation/u,
      ],
    ];
    for (const [name, responses, pattern] of cases) {
      const output = await outputFixture();
      const fixture = ghFixture(responses);
      try {
        await assert.rejects(
          upsertDocPreviewComment(output.input, { gh: fixture.gh }),
          pattern,
          name,
        );
        await removed(output.outputPath);
      } finally {
        await dispose(output);
      }
    }
  });
});

describe("bounded gh api child", () => {
  it("attaches the stdin error listener before end and passes only an allowlisted environment", async () => {
    const capture = { stdin: "" };
    const spawnImpl = (command, args, options) => {
      const child = fakeChild();
      capture.command = command;
      capture.args = args;
      capture.options = options;
      child.stdin.on("data", (chunk) => {
        capture.stdin += chunk.toString("utf8");
      });
      let stdinErrorAttached = false;
      const originalOnce = child.stdin.once.bind(child.stdin);
      child.stdin.once = (event, listener) => {
        if (event === "error") stdinErrorAttached = true;
        return originalOnce(event, listener);
      };
      const originalEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...values) => {
        capture.listenerBeforeEnd = stdinErrorAttached;
        return originalEnd(...values);
      };
      queueMicrotask(() => {
        child.stdout.write("[]");
        child.emit("close", 0, null);
      });
      return child;
    };
    const args = ["api", "--method", "POST", "--input", "-", "repos/o/r/issues/1/comments"];
    const result = await runGh(args, {
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-secret",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
        DOC_PREVIEW_OUTPUT_PATH: "/tmp/private-output",
        GH_TOKEN: "github-token",
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        PREVIEW_READ_TOKEN: "read-secret",
        STASH_ADMIN_TOKEN: "admin-secret",
      },
      input: '{"body":"safe"}\n',
      spawnImpl,
    });

    assert.equal(result, "[]");
    assert.equal(capture.command, "gh");
    assert.deepEqual(capture.args, args);
    assert.deepEqual(capture.options.env, {
      GH_TOKEN: "github-token",
      HOME: "/tmp/home",
      PATH: "/usr/bin",
    });
    assert.deepEqual(capture.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(capture.listenerBeforeEnd, true);
    assert.equal(capture.stdin, '{"body":"safe"}\n');
  });

  it("redacts synchronous and emitted spawn errors", async () => {
    await assert.rejects(
      runGh(["api"], {
        spawnImpl: () => {
          throw new Error("secret synchronous detail");
        },
      }),
      (error) => error.message === "Unable to start gh api" && !error.message.includes("secret"),
    );

    const spawnImpl = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", new Error("secret emitted detail")));
      return child;
    };
    await assert.rejects(
      runGh(["api"], { spawnImpl }),
      (error) => error.message === "Unable to start gh api" && !error.message.includes("secret"),
    );
  });

  it("redacts nonzero exits and signals", async () => {
    for (const [code, signal] of [
      [2, null],
      [null, "SIGTERM"],
    ]) {
      const spawnImpl = () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write("secret stderr detail");
          child.emit("close", code, signal);
        });
        return child;
      };
      await assert.rejects(
        runGh(["api"], { spawnImpl }),
        (error) =>
          error.message === "gh api did not complete successfully" &&
          !error.message.includes("secret"),
      );
    }
  });

  it("handles stdin EPIPE after installing the listener", async () => {
    let listenerBeforeEnd = false;
    const spawnImpl = () => {
      const child = fakeChild();
      let attached = false;
      const originalOnce = child.stdin.once.bind(child.stdin);
      child.stdin.once = (event, listener) => {
        if (event === "error") attached = true;
        return originalOnce(event, listener);
      };
      child.stdin.end = () => {
        listenerBeforeEnd = attached;
        child.stdin.emit("error", Object.assign(new Error("secret EPIPE"), { code: "EPIPE" }));
        return child.stdin;
      };
      return child;
    };
    await assert.rejects(
      runGh(["api"], { input: '{"body":"safe"}', spawnImpl }),
      /closed stdin before reading/u,
    );
    assert.equal(listenerBeforeEnd, true);
  });

  it("bounds stdout and stderr without replaying their content", async () => {
    for (const streamName of ["stdout", "stderr"]) {
      let child;
      const spawnImpl = () => {
        child = fakeChild();
        queueMicrotask(() => {
          child[streamName].write("secret-overflow");
          child.emit("close", null, "SIGTERM");
        });
        return child;
      };
      await assert.rejects(
        runGh(["api"], { maxOutputBytes: 5, spawnImpl }),
        (error) =>
          error.message === "gh api output exceeded the safety limit" &&
          !error.message.includes("secret"),
      );
      assert.equal(child.killed, true);
    }
  });
});
