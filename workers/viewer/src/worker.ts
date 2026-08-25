interface FetchBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ViewerEnv {
  ASSETS: FetchBinding;
  STASH?: FetchBinding;
  STASH_BASE_URL?: string;
}

const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "if-none-match",
  "idempotency-key",
] as const;

function proxyHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function requestInit(request: Request): RequestInit {
  return {
    method: request.method,
    headers: proxyHeaders(request),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    signal: request.signal,
  };
}

export async function handleViewerRequest(request: Request, env: ViewerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const prefix = "/api/v1/";
    if (!url.pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });

    const rest = url.pathname.slice(prefix.length);
    const init = requestInit(request);
    const baseUrl = env.STASH_BASE_URL?.trim().replace(/\/+$/u, "");

    if (baseUrl) return fetch(`${baseUrl}/v1/${rest}${url.search}`, init);
    if (env.STASH) return env.STASH.fetch(`https://stash.internal/v1/${rest}${url.search}`, init);
    throw new Error("Viewer proxy requires either STASH or STASH_BASE_URL");
  }

  return env.ASSETS.fetch(request);
}

export default { fetch: handleViewerRequest };
