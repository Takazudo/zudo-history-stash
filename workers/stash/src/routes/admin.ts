import { Hono } from "hono";
import type { AppEnv } from "../context.js";

/** Placeholder for administrator routes. */
const admin = new Hono<AppEnv>();

export default admin;
