import { describe, expect, it, vi } from "vitest";
import { createRefreshScheduler } from "./refresh-scheduler.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createRefreshScheduler", () => {
  it("runs one task per key and retains only the newest trailing task for a busy key", async () => {
    const scheduler = createRefreshScheduler<string>();
    const first = deferred();
    const calls: string[] = [];

    scheduler.schedule("files", async () => {
      calls.push("files:first");
      await first.promise;
    });
    scheduler.schedule("files", () => {
      calls.push("files:discarded");
    });
    scheduler.schedule("files", () => {
      calls.push("files:trailing");
    });
    scheduler.schedule("history", () => {
      calls.push("history:first");
    });

    await vi.waitFor(() => expect(calls).toEqual(["files:first", "history:first"]));
    first.resolve();
    await vi.waitFor(() =>
      expect(calls).toEqual(["files:first", "history:first", "files:trailing"]),
    );
  });

  it("releases a rejected key and still runs its coalesced trailing task", async () => {
    const scheduler = createRefreshScheduler<string>();
    const first = deferred();
    const trailing = vi.fn();

    scheduler.schedule("stash", () => first.promise);
    scheduler.schedule("stash", trailing);
    first.reject(new Error("refresh failed"));

    await vi.waitFor(() => expect(trailing).toHaveBeenCalledOnce());
    scheduler.schedule("stash", trailing);
    await vi.waitFor(() => expect(trailing).toHaveBeenCalledTimes(2));
  });

  it("drops trailing and future work after close", async () => {
    const scheduler = createRefreshScheduler<string>();
    const first = deferred();
    const trailing = vi.fn();

    scheduler.schedule("stash", () => first.promise);
    scheduler.schedule("stash", trailing);
    await Promise.resolve();
    scheduler.close();
    first.resolve();
    scheduler.schedule("stash", trailing);
    await Promise.resolve();
    await Promise.resolve();

    expect(trailing).not.toHaveBeenCalled();
  });

  it("does not start queued work when close wins before its microtask", async () => {
    const scheduler = createRefreshScheduler<string>();
    const task = vi.fn();

    scheduler.schedule("stash", task);
    scheduler.close();
    await Promise.resolve();

    expect(task).not.toHaveBeenCalled();
  });
});
