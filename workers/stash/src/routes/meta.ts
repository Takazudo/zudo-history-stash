import { Hono } from "hono";
import type { AppEnv } from "../context.js";

export const healthResponse = {
  ok: true,
  service: "zudo-history-stash",
  marker: "ZHS_HEALTH_OK",
} as const;

const meta = new Hono<AppEnv>();
meta.get("/v1/me", (c) => {
  const principal = c.get("principal");
  return c.json(
    principal.kind === "admin"
      ? { principal: "admin" as const }
      : {
          principal: "stash" as const,
          stash: principal.stash,
          tokenId: principal.tokenId,
          scope: principal.scope,
          expiresAt: principal.expiresAt,
        },
  );
});

export default meta;
