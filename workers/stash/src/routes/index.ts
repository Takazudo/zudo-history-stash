import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import { rateLimit } from "../rate-limit.js";
import admin from "./admin.js";
import diff from "./diff.js";
import files from "./files.js";
import gc from "./gc.js";
import history from "./history.js";
import importRoutes from "./import.js";
import lifecycle from "./lifecycle.js";
import meta from "./meta.js";
import proposals from "./proposals.js";

function middlewarePath(route: (typeof ROUTES)[number]): string {
  // Diff handlers accept Hono's empty wildcard; other wildcard handlers require a file path.
  const wildcard = route.id === "getDiff" || route.id === "diffCandidate" ? "*" : ":path{.+}";
  return route.template.replace("*path", wildcard);
}

const routes = new Hono<AppEnv>();
for (const route of ROUTES) {
  if (route.principal !== "open") {
    routes.on(route.method, middlewarePath(route), requireRoute(route.id), rateLimit(route.id));
  }
}
routes.route("/", meta);
routes.route("/", admin);
routes.route("/", files);
routes.route("/", gc);
routes.route("/", history);
routes.route("/", diff);
routes.route("/", importRoutes);
routes.route("/", lifecycle);
routes.route("/", proposals);
routes.all("/v1/*", (c) =>
  c.json(
    { error: { code: "not-implemented", message: "This route is not implemented yet." } },
    501,
  ),
);

export default routes;
