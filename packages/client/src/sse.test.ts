import { describe, expect, it, vi } from "vitest";
import { parseStashEventStream, StashEventProtocolError } from "./sse.js";

const encoder = new TextEncoder();

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return byteStream(chunks.map((chunk) => encoder.encode(chunk)));
}

async function collect(body: ReadableStream<Uint8Array>) {
  const result = [];
  for await (const event of parseStashEventStream(body)) result.push(event);
  return result;
}

describe("parseStashEventStream", () => {
  it("parses every single split position, including a split UTF-8 code point", async () => {
    const frame =
      'event: change\nid: 42\ndata: {"type":"change","changeId":42,"commitId":"legacy:42","stash":"notes","path":"文書/é.md","version":3,"kind":"put","origin":"tab-a","createdAt":"2026-08-28T01:02:03.000Z"}\n\n';
    const bytes = encoder.encode(frame);

    for (let split = 0; split <= bytes.length; split += 1) {
      const parsed = await collect(byteStream([bytes.slice(0, split), bytes.slice(split)]));
      expect(parsed, `split byte ${split}`).toEqual([
        {
          id: "42",
          event: {
            type: "change",
            changeId: 42,
            commitId: "legacy:42",
            stash: "notes",
            path: "文書/é.md",
            version: 3,
            kind: "put",
            origin: "tab-a",
            createdAt: "2026-08-28T01:02:03.000Z",
          },
        },
      ]);
    }
  });

  it("accepts CR, LF, and CRLF while joining multi-line data", async () => {
    const parsed = await collect(
      textStream(
        ': heartbeat\r\nevent: ready\rdata: {"type":"ready",\n',
        'data: "head":7,"checkpoint":7}\r\n\r\nevent: reconnect\n',
        'data: {"type":"reconnect","reason":"lifetime"}\n\n',
      ),
    );

    expect(parsed).toEqual([
      { event: { type: "ready", head: 7, checkpoint: 7 } },
      { event: { type: "reconnect", reason: "lifetime" } },
    ]);
  });

  it("parses commit and change-set frames while requiring commitId on changes", async () => {
    const commit = {
      type: "commit" as const,
      commitId: "cmt_1787952000000deadbeef",
      stash: "notes",
      entryCount: 2,
      firstChangeId: 10,
      lastChangeId: 11,
      origin: null,
    };
    const changeSet = {
      type: "change-set" as const,
      changeSetId: "chs_1787952000000deadbeef",
      stash: "notes",
      status: "applied" as const,
      paths: ["a.md", "b.bin"],
      origin: null,
    };
    const parsed = await collect(
      textStream(
        `event: commit\ndata: ${JSON.stringify(commit)}\n\n`,
        `event: change\nid: 10\ndata: ${JSON.stringify({
          type: "change",
          changeId: 10,
          commitId: commit.commitId,
          stash: "notes",
          path: "a.md",
          version: 1,
          kind: "put",
          origin: null,
          createdAt: "2026-08-28T01:02:03.000Z",
        })}\n\n`,
        `event: change-set\ndata: ${JSON.stringify(changeSet)}\n\n`,
      ),
    );

    expect(parsed.map(({ event }) => event)).toEqual([
      commit,
      {
        type: "change",
        changeId: 10,
        commitId: commit.commitId,
        stash: "notes",
        path: "a.md",
        version: 1,
        kind: "put",
        origin: null,
        createdAt: "2026-08-28T01:02:03.000Z",
      },
      changeSet,
    ]);
    expect(parsed[1]?.id).toBe("10");
  });

  it("uses the first colon, removes only one optional space, and ignores unknown fields", async () => {
    const parsed = await collect(
      textStream(
        "retry: 1000\n",
        "event: change-set\n",
        "id: opaque:value\n",
        'data:  {"type":"change-set","changeSetId":"chs_1724800000000deadbeef","stash":"s","status":"open","paths":["a.md"],"origin":null}\n\n',
        'event: ready\ndata:{"type":"ready","head":null,"checkpoint":null}\n\n',
      ),
    );

    expect(parsed).toEqual([
      {
        id: "opaque:value",
        event: {
          type: "change-set",
          changeSetId: "chs_1724800000000deadbeef",
          stash: "s",
          status: "open",
          paths: ["a.md"],
          origin: null,
        },
      },
      { event: { type: "ready", head: null, checkpoint: null } },
    ]);
  });

  it("parses multiple frames per chunk and ignores heartbeats and a trailing partial frame", async () => {
    const parsed = await collect(
      textStream(
        ': ping\n\nevent: ready\ndata: {"type":"ready","head":1,"checkpoint":1}\n\n' +
          'event: reconnect\ndata: {"type":"reconnect","reason":"shutdown"}\n\n' +
          'event: ready\ndata: {"type":"ready","head":2,"checkpoint":2}',
      ),
    );

    expect(parsed.map(({ event }) => event)).toEqual([
      { type: "ready", head: 1, checkpoint: 1 },
      { type: "reconnect", reason: "shutdown" },
    ]);
  });

  it.each([
    ["malformed JSON", "event: ready\ndata: nope\n\n"],
    ["unknown event schema", 'event: mystery\ndata: {"type":"mystery"}\n\n'],
    ["event/data mismatch", 'event: ready\ndata: {"type":"reconnect","reason":"shutdown"}\n\n'],
    [
      "missing change id",
      'event: change\ndata: {"type":"change","changeId":2,"stash":"s","path":"a","version":1,"kind":"put","origin":null,"createdAt":"2026-08-28T01:02:03.000Z"}\n\n',
    ],
    [
      "mismatched change id",
      'event: change\nid: 1\ndata: {"type":"change","changeId":2,"stash":"s","path":"a","version":1,"kind":"put","origin":null,"createdAt":"2026-08-28T01:02:03.000Z"}\n\n',
    ],
  ])("rejects %s rather than yielding it", async (_name, frame) => {
    await expect(collect(textStream(frame))).rejects.toBeInstanceOf(StashEventProtocolError);
  });

  it("cancels the body when its consumer returns early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: ready\ndata: {"type":"ready","head":1,"checkpoint":1}\n\n'),
        );
      },
      cancel,
    });

    for await (const _event of parseStashEventStream(body)) break;

    expect(cancel).toHaveBeenCalledOnce();
  });
});
