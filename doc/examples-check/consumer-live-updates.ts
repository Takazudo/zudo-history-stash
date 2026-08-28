import {
  createStashClient,
  type StashEvent,
  type StashEventStream,
  type StashLiveStatus,
} from "@takazudo/zudo-history-stash";

export function openAdvisoryUpdates(input: {
  baseUrl: string;
  readToken: string;
  stash: string;
  clientId: string;
  refreshAuthoritativeState: (event: StashEvent) => Promise<void>;
  onRemoteHint: (event: StashEvent) => void;
  onStatus: (status: StashLiveStatus, failureCount: number) => void;
}): { stream: StashEventStream; done: Promise<void>; close: () => void } {
  const client = createStashClient({
    baseUrl: input.baseUrl,
    token: input.readToken,
    clientId: input.clientId,
  });
  const abort = new AbortController();
  const stream = client.files(input.stash).events({ signal: abort.signal });
  const unsubscribe = stream.onStatus((status) => {
    input.onStatus(status, stream.failureCount);
  });

  const done = (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "ready" || event.type === "change" || event.type === "proposal") {
          await input.refreshAuthoritativeState(event);
        }
        if (
          (event.type === "change" || event.type === "proposal") &&
          event.origin !== input.clientId
        ) {
          input.onRemoteHint(event);
        }
      }
    } finally {
      unsubscribe();
      stream.close();
    }
  })();

  return {
    stream,
    done,
    close() {
      abort.abort();
      stream.close();
      unsubscribe();
    },
  };
}
