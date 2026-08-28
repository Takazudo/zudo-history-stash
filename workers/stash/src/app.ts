import { BODY_LIMIT_BYTES, StashError } from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requireToken } from "./auth.js";
import type { AppDependencies, AppEnv } from "./context.js";
import { onError } from "./errors.js";
import { capabilitiesResponse, healthResponse } from "./routes/meta.js";
import routes from "./routes/index.js";

const ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  "If-None-Match",
  "If-Range",
  "Range",
  "Idempotency-Key",
  "X-Stash-Client-Id",
];
const EXPOSE_HEADERS = [
  "ETag",
  "X-Stash-Version",
  "Idempotent-Replayed",
  "Retry-After",
  "Accept-Ranges",
  "Content-Length",
  "Content-Range",
  "Content-Disposition",
  "X-Content-Type-Options",
];

function allowedOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

const defaultDependencies: AppDependencies = {
  now: () => Date.now(),
  createId: () => crypto.randomUUID(),
  uploadLeaseMs: 30_000,
  uploadHooks: {},
};

export function createApp(dependencies: Partial<AppDependencies> = {}): Hono<AppEnv> {
  const deps = { ...defaultDependencies, ...dependencies };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin === undefined || !allowedOrigins(c.env.ALLOWED_ORIGINS).has(origin)) {
      await next();
      return;
    }
    return cors({ origin, allowHeaders: ALLOW_HEADERS, exposeHeaders: EXPOSE_HEADERS })(c, next);
  });
  const limitJsonBody = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: () => {
      throw new StashError("payload-too-large", "The request payload is too large.");
    },
  });
  app.use("*", async (c, next) => {
    const rawUpload =
      c.req.method === "PUT" &&
      /^\/v1\/stashes\/[^/]+\/uploads\/[^/]+\/(?:content|parts\/[^/]+)$/.test(c.req.path);
    return rawUpload ? next() : limitJsonBody(c, next);
  });
  app.get("/v1/health", (c) => c.json(healthResponse));
  app.get("/v1/capabilities", (c) => c.json(capabilitiesResponse(c.env)));
  app.use("/v1/*", requireToken);
  app.route("/", routes);
  app.notFound((c) =>
    c.json({ error: { code: "not-found", message: "The requested resource was not found." } }, 404),
  );
  app.onError(onError);
  return app;
}

export const app = createApp();
export default app;
