import { Hono } from "hono";
import admin from "./admin.js";
import diff from "./diff.js";
import files from "./files.js";
import history from "./history.js";
import importRoutes from "./import.js";
import meta from "./meta.js";

/** Mount point shared by the route modules owned by later tasks. */
const routes = new Hono();
routes.route("/", meta);
routes.route("/", admin);
routes.route("/", files);
routes.route("/", history);
routes.route("/", diff);
routes.route("/", importRoutes);

export default routes;
