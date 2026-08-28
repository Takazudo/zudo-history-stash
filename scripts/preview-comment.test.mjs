import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PREVIEW_COMMENT_MARKER,
  renderPreviewComment,
  upsertPreviewComment,
} from "./preview-comment.mjs";

const INPUT = {
  pr: "157",
  repository: "Takazudo/zudo-history-stash",
  sha: "0123456789abcdef0123456789abcdef01234567",
  stashUrl: "https://zudo-history-stash-pr-157.example.workers.dev",
  token: "zhs_preview_read_secret",
  viewerUrl: "https://zudo-history-stash-viewer-pr-157.example.workers.dev",
};

function ghFixture(responses) {
  const calls = [];
  const remaining = [...responses];
  const gh = async (args, options = {}) => {
    calls.push({ args, options });
    assert.notEqual(remaining.length, 0, `Unexpected gh call: ${args.join(" ")}`);
    const result = remaining.shift();
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, gh, remaining };
}

describe("preview PR comment", () => {
  it("renders the exact marker first and labels the token read-only", () => {
    const body = renderPreviewComment(INPUT);
    assert.equal(body.split("\n")[0], PREVIEW_COMMENT_MARKER);
    assert.match(body, /Read-only demo token/u);
    assert.match(body, /cannot mutate/u);
    assert.match(body, new RegExp(INPUT.sha, "u"));
  });

  it("creates one comment with JSON on stdin and no token in argv", async () => {
    const fixture = ghFixture([JSON.stringify([[]]), "created-response-with-body-is-discarded"]);
    const result = await upsertPreviewComment(INPUT, { gh: fixture.gh });

    assert.deepEqual(result, { action: "created", commentId: null });
    assert.match(fixture.calls[0].args.at(-1), /comments\?per_page=100$/u);
    assert.deepEqual(fixture.calls[1].args.slice(0, 3), ["api", "--method", "POST"]);
    assert.equal(fixture.calls.flatMap(({ args }) => args).includes(INPUT.token), false);
    assert.deepEqual(JSON.parse(fixture.calls[1].options.input), {
      body: renderPreviewComment(INPUT),
    });
    assert.deepEqual(fixture.remaining, []);
  });

  it("updates the single bot-owned exact marker found on a later page", async () => {
    const fixture = ghFixture([
      JSON.stringify([
        [{ id: 1, body: PREVIEW_COMMENT_MARKER, user: { login: "someone" } }],
        [
          {
            id: 42,
            body: `${PREVIEW_COMMENT_MARKER}\nold`,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
      "updated-response",
    ]);
    const result = await upsertPreviewComment(INPUT, { gh: fixture.gh });

    assert.deepEqual(result, { action: "updated", commentId: 42 });
    assert.deepEqual(fixture.calls[1].args.slice(0, 3), ["api", "--method", "PATCH"]);
    assert.equal(
      fixture.calls[1].args.at(-1),
      "repos/Takazudo/zudo-history-stash/issues/comments/42",
    );
  });

  it("updates the same marker to a token- and URL-free torn-down state", async () => {
    const oldBody = renderPreviewComment(INPUT);
    const fixture = ghFixture([
      JSON.stringify([
        [
          {
            id: 43,
            body: oldBody,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
      "updated-response",
    ]);
    const result = await upsertPreviewComment(
      {
        mode: "torn-down",
        pr: INPUT.pr,
        repository: INPUT.repository,
      },
      { gh: fixture.gh },
    );

    assert.deepEqual(result, { action: "updated", commentId: 43 });
    const body = JSON.parse(fixture.calls[1].options.input).body;
    assert.equal(body.split("\n")[0], PREVIEW_COMMENT_MARKER);
    assert.match(body, /have been torn down/u);
    assert.equal(body.includes(INPUT.token), false);
    assert.equal(body.includes(INPUT.viewerUrl), false);
    assert.equal(body.includes(INPUT.stashUrl), false);
    assert.equal(fixture.calls.flatMap(({ args }) => args).includes(INPUT.token), false);
  });

  it("ignores human and inexact markers", async () => {
    const fixture = ghFixture([
      JSON.stringify([
        [
          { id: 1, body: PREVIEW_COMMENT_MARKER, user: { login: "human" } },
          {
            id: 2,
            body: `prefix ${PREVIEW_COMMENT_MARKER}`,
            user: { login: "github-actions[bot]" },
          },
        ],
      ]),
      "created",
    ]);
    assert.deepEqual(await upsertPreviewComment(INPUT, { gh: fixture.gh }), {
      action: "created",
      commentId: null,
    });
  });

  it("fails closed on duplicate bot-owned markers without mutating", async () => {
    const fixture = ghFixture([
      JSON.stringify([
        [
          { id: 1, body: PREVIEW_COMMENT_MARKER, user: { login: "github-actions[bot]" } },
          { id: 2, body: `${PREVIEW_COMMENT_MARKER}\nold`, user: { login: "github-actions[bot]" } },
        ],
      ]),
    ]);
    await assert.rejects(
      upsertPreviewComment(INPUT, { gh: fixture.gh }),
      /Multiple bot-owned PR preview comments/u,
    );
    assert.equal(fixture.calls.length, 1);
  });

  it("propagates list and mutation failures and rejects malformed list JSON", async () => {
    await assert.rejects(
      upsertPreviewComment(INPUT, { gh: ghFixture([new Error("list failed")]).gh }),
      /list failed/u,
    );
    await assert.rejects(
      upsertPreviewComment(INPUT, { gh: ghFixture(["not json"]).gh }),
      /malformed comment JSON/u,
    );
    await assert.rejects(
      upsertPreviewComment(INPUT, {
        gh: ghFixture([JSON.stringify([[]]), new Error("post failed")]).gh,
      }),
      /post failed/u,
    );
  });
});
