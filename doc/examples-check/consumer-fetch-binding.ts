import { createStashClient } from "@takazudo/zudo-history-stash";

export interface StashFetchBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createFetchBindingClient(input: { binding: StashFetchBinding; token: string }) {
  return createStashClient({
    baseUrl: "https://stash.internal",
    token: input.token,
    fetch: (request, init) => input.binding.fetch(request, init),
  });
}
