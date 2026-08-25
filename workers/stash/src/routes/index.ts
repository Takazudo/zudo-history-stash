import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { Hono } from "hono";
import { requireRoute } from "../auth.js";
import type { AppEnv } from "../context.js";
import admin from "./admin.js";
import diff from "./diff.js";
import files from "./files.js";
import history from "./history.js";
import importRoutes from "./import.js";
import meta from "./meta.js";

const routes = new Hono<AppEnv>();
for (const route of ROUTES) {
  if (route.principal !== "open") {
    routes.on(route.method, route.template.replace("*path", "*"), requireRoute(route.id));
  }
}
routes.route("/", meta);
routes.route("/", admin);
routes.route("/", files);
routes.route("/", history);
routes.route("/", diff);
routes.route("/", importRoutes);
routes.all("/v1/*", (c) =>
  c.json(
    { error: { code: "not-implemented", message: "This route is not implemented yet." } },
    501,
  ),
);

export default routes;
