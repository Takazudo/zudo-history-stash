import { BODY_LIMIT_BYTES, StashError } from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requireToken } from "./auth.js";
import type { AppEnv } from "./context.js";
import { onError } from "./errors.js";
import { healthResponse } from "./routes/meta.js";
import routes from "./routes/index.js";

const ALLOW_HEADERS = ["Authorization", "Content-Type", "If-None-Match", "Idempotency-Key"];
const EXPOSE_HEADERS = ["ETag", "X-Stash-Version", "Idempotent-Replayed"];

function allowedOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin === undefined || !allowedOrigins(c.env.ALLOWED_ORIGINS).has(origin)) {
      await next();
      return;
    }
    return cors({ origin, allowHeaders: ALLOW_HEADERS, exposeHeaders: EXPOSE_HEADERS })(c, next);
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: () => {
        throw new StashError("payload-too-large", "The request payload is too large.");
      },
    }),
  );
  app.get("/v1/health", (c) => c.json(healthResponse));
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
