import { ROUTES } from "@takazudo/zudo-history-stash-core";
import { describe, expect, it } from "vitest";
import apiReference from "../../../../docs/api.md?raw";

describe("API reference route coverage", () => {
  for (const route of ROUTES) {
    it(`documents ${route.method} ${route.template}`, () => {
      expect(apiReference).toContain(`### \`${route.method} ${route.template}\``);
    });
  }
});
