import { Hono } from "hono";
import routes from "./routes/index.js";

/** Composition seam for the API routes added by later stash tasks. */
export const app = new Hono();
app.route("/", routes);

export default app;
