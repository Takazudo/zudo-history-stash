import type { RpcRequest } from "@takazudo/zudo-history-stash-core";
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app.js";
import type { Env } from "./env.js";

function acceptsBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function requestUrl(init: RpcRequest): string {
  const query = new URLSearchParams(init.query).toString();
  return `https://stash.internal${init.path}${query === "" ? "" : `?${query}`}`;
}

export class StashRpc extends WorkerEntrypoint<Env> {
  async request(init: RpcRequest): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("authorization");
    headers.set("Authorization", `Bearer ${init.token}`);
    const request = new Request(requestUrl(init), {
      method: init.method,
      headers,
      body: acceptsBody(init.method) ? init.body : undefined,
    });
    return app.fetch(request, this.env, this.ctx);
  }
}
