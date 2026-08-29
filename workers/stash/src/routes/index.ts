import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import { rateLimit } from "../rate-limit.js";
import admin from "./admin.js";
import changeSets from "./change-sets.js";
import commits from "./commits.js";
import diff from "./diff.js";
import events from "./events.js";
import files from "./files.js";
import gc from "./gc.js";
import history from "./history.js";
import importRoutes from "./import.js";
import lifecycle from "./lifecycle.js";
import meta from "./meta.js";
import rawContent from "./raw-content.js";
import snapshot from "./snapshot.js";
import uploads from "./uploads.js";

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
routes.route("/", changeSets);
routes.route("/", commits);
routes.route("/", files);
routes.route("/", gc);
routes.route("/", history);
routes.route("/", diff);
routes.route("/", importRoutes);
routes.route("/", lifecycle);
routes.route("/", events);
routes.route("/", rawContent);
routes.route("/", snapshot);
routes.route("/", uploads);
routes.all("/v1/*", (c) => {
  void c.env.CHANGE_SET_TTL_DAYS;
  return c.json(
    { error: { code: "not-implemented", message: "This route is not implemented yet." } },
    501,
  );
});

export default routes;
