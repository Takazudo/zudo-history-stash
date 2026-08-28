import type { RouteMethod } from "@takazudo/zudo-history-stash-core";
import type { StashRpcBinding } from "./rpc-types.js";

/** A fetch implementation supplied by the host (browser, Node, or a Worker binding). */
export type StashFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** String query parameters passed through either client transport. */
export type TransportQuery = Record<string, string>;

/** The single request seam shared by the fetch and RPC client transports. */
export type Send = (
  method: RouteMethod,
  path: string,
  query: TransportQuery | undefined,
  headers: Record<string, string>,
  body: BodyInit | null | undefined,
  signal?: AbortSignal,
) => Promise<Response>;

function joinBaseUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function appendQuery(url: string, query: TransportQuery | undefined): string {
  if (query === undefined) return url;
  const serialized = new URLSearchParams(query).toString();
  return serialized.length === 0 ? url : `${url}?${serialized}`;
}

/** Creates the existing HTTP/fetch request path without changing its request bytes. */
export function createFetchSend(fetcher: StashFetch, baseUrl: string): Send {
  return (method, path, query, headers, body, signal) =>
    fetcher(appendQuery(joinBaseUrl(baseUrl, path), query), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      ...(body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
    });
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
}

/** Creates an in-process RPC request path. The dedicated token always wins over headers. */
export function createRpcSend(binding: StashRpcBinding, token: string): Send {
  return (method, path, query, headers, body, signal) => {
    const rpcHeaders = withoutAuthorization(headers);
    const needsStreamBridge =
      body instanceof ReadableStream ||
      body instanceof Blob ||
      body instanceof ArrayBuffer ||
      path === "/v1/capabilities" ||
      path.includes("/raw/") ||
      path.includes("/uploads/");
    if (!needsStreamBridge || binding.requestStream === undefined) {
      if (needsStreamBridge && body instanceof ReadableStream) {
        throw new TypeError("The RPC binding does not expose the byte-stream request bridge");
      }
      return binding.request({
        method,
        path,
        ...(query === undefined ? {} : { query }),
        ...(Object.keys(rpcHeaders).length === 0 ? {} : { headers: rpcHeaders }),
        ...(body === undefined || body === null ? {} : { body: String(body) }),
        token,
      });
    }
    const serializedQuery = query === undefined ? "" : new URLSearchParams(query).toString();
    const url = `https://stash.internal${path}${serializedQuery === "" ? "" : `?${serializedQuery}`}`;
    const request = new Request(url, {
      method,
      headers: rpcHeaders,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
      ...(body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
    });
    return binding.requestStream(request, token);
  };
}
