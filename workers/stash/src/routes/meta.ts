import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { capabilitiesFor, parseBinarySettings } from "../binary-config.js";

export const healthResponse = {
  ok: true,
  service: "zudo-history-stash",
  marker: "ZHS_HEALTH_OK",
} as const;

const meta = new Hono<AppEnv>();
export const capabilitiesResponse = (env: AppEnv["Bindings"]) =>
  capabilitiesFor(parseBinarySettings(env));

meta.get("/v1/capabilities", (c) => c.json(capabilitiesResponse(c.env)));
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
