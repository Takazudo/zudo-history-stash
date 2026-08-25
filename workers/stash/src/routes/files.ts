import { Hono } from "hono";
import type { AppEnv } from "../context.js";

/** Placeholder for file read/write routes. */
const files = new Hono<AppEnv>();

export default files;
