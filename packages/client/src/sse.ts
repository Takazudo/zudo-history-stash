import { StashEventSchema } from "@takazudo/zudo-history-stash-core";
import type { StashEvent } from "@takazudo/zudo-history-stash-core";

/** A validated event together with the SSE id that framed it. */
export interface ParsedStashEvent {
  event: StashEvent;
  id?: string;
}

/** Raised when a complete SSE frame does not satisfy the live-event contract. */
export class StashEventProtocolError extends Error {
  override readonly name = "StashEventProtocolError";
}

type Frame = {
  event?: string;
  id?: string;
  data: string[];
};

function emptyFrame(): Frame {
  return { data: [] };
}

function parseFrame(frame: Frame): ParsedStashEvent | undefined {
  if (frame.data.length === 0) return undefined;

  if (frame.event === undefined) {
    throw new StashEventProtocolError("stash event frame is missing an event name");
  }

  let value: unknown;
  try {
    value = JSON.parse(frame.data.join("\n")) as unknown;
  } catch (error) {
    throw new StashEventProtocolError("stash event frame contains malformed JSON", {
      cause: error,
    });
  }

  const parsed = StashEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new StashEventProtocolError("stash event frame does not match the event schema", {
      cause: parsed.error,
    });
  }
  if (frame.event !== parsed.data.type) {
    throw new StashEventProtocolError("stash event name does not match its data type");
  }

  if (parsed.data.type === "change") {
    if (frame.id === undefined || !/^\d+$/.test(frame.id)) {
      throw new StashEventProtocolError("change event is missing a numeric id");
    }
    const changeId = Number(frame.id);
    if (!Number.isSafeInteger(changeId) || changeId !== parsed.data.changeId) {
      throw new StashEventProtocolError("change event id does not match changeId");
    }
  }

  return frame.id === undefined ? { event: parsed.data } : { event: parsed.data, id: frame.id };
}

function updateFrame(frame: Frame, line: string): void {
  if (line.startsWith(":")) return;

  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);

  if (field === "event") frame.event = value;
  else if (field === "id") frame.id = value;
  else if (field === "data") frame.data.push(value);
}

/**
 * Incrementally parses and validates History Stash SSE frames.
 *
 * The parser owns its reader while iteration is active. Returning from iteration early cancels the
 * response body so a reconnect cannot leave the previous fetch alive.
 */
export async function* parseStashEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedStashEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let frame = emptyFrame();
  let completed = false;
  const cancelForAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {
      // The body may race a remote close or a parser failure.
    });
  };
  if (signal?.aborted) cancelForAbort();
  else signal?.addEventListener("abort", cancelForAbort, { once: true });

  const processLines = function* (atEnd: boolean): Generator<ParsedStashEvent> {
    while (true) {
      const lf = buffer.indexOf("\n");
      const cr = buffer.indexOf("\r");
      let lineEnd: number;
      if (lf === -1) lineEnd = cr;
      else if (cr === -1) lineEnd = lf;
      else lineEnd = Math.min(lf, cr);
      if (lineEnd === -1) return;

      const separator = buffer[lineEnd];
      if (separator === "\r" && lineEnd === buffer.length - 1 && !atEnd) return;
      const separatorLength = separator === "\r" && buffer[lineEnd + 1] === "\n" ? 2 : 1;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + separatorLength);

      if (line.length === 0) {
        const parsed = parseFrame(frame);
        frame = emptyFrame();
        if (parsed !== undefined) yield parsed;
      } else {
        updateFrame(frame, line);
      }
    }
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        for (const parsed of processLines(true)) yield parsed;
        completed = true;
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      for (const parsed of processLines(false)) yield parsed;
    }
  } catch (error) {
    if (error instanceof StashEventProtocolError) throw error;
    throw new StashEventProtocolError("stash event stream could not be decoded", { cause: error });
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The underlying stream may already be errored or aborted.
      }
    }
    reader.releaseLock();
  }
}
