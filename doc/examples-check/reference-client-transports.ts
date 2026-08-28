import {
  createStashClient,
  type StashClient,
  type StashFetch,
  type StashRpcBinding,
} from "@takazudo/zudo-history-stash";

export function createFetchClient(options: {
  baseUrl: string;
  token: string;
  clientId: string;
  fetch?: StashFetch;
}): StashClient {
  return createStashClient({
    baseUrl: options.baseUrl,
    token: options.token,
    clientId: options.clientId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export function createRpcClient(options: {
  binding: StashRpcBinding;
  token: string;
  clientId: string;
}): StashClient {
  return createStashClient({
    clientId: options.clientId,
    transport: {
      kind: "rpc",
      binding: options.binding,
      token: options.token,
    },
  });
}
