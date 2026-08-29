import { beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { app } from "../src/app.js";
import { createTestEnv } from "./helpers/env.js";
import { request, seedStash } from "./helpers/app.js";

const skeletons = [
  ["POST", "/v1/stashes/route-pin/commits"],
  ["GET", "/v1/stashes/route-pin/commits/cmt_1"],
  ["GET", "/v1/stashes/route-pin/commits"],
  ["GET", "/v1/stashes/route-pin/commits/cmt_1/diff"],
  ["POST", "/v1/stashes/route-pin/commits/cmt_1/revert"],
  ["GET", "/v1/stashes/route-pin/snapshot"],
  ["POST", "/v1/stashes/route-pin/change-sets"],
  ["GET", "/v1/stashes/route-pin/change-sets"],
  ["GET", "/v1/stashes/route-pin/change-sets/chs_1"],
  ["GET", "/v1/stashes/route-pin/change-sets/chs_1/diff"],
  ["POST", "/v1/stashes/route-pin/change-sets/chs_1/approve"],
  ["POST", "/v1/stashes/route-pin/change-sets/chs_1/reject"],
] as const;

describe("route skeleton", () => {
  beforeAll(() => seedStash("route-pin"));
  it("pins all 49 route declarations", () => expect(ROUTES).toHaveLength(49));
  it.each(skeletons)("returns 501 for %s %s", async (method, path) => {
    const { env } = createTestEnv();
    const response = await request(app, `https://stash.test${path}`, { method, headers: { Authorization: "Bearer test-admin", "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined }, env);
    expect(response.status).toBe(501);
  });
});
