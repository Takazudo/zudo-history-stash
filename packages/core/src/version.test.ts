import { createRequire } from "node:module";

import { expect, it } from "vitest";
import { VERSION } from "./index.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

it("exposes the package.json version", () => {
  expect(VERSION).toBe(packageJson.version);
});
