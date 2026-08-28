import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/openapi/index.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  define: {
    __CORE_VERSION__: JSON.stringify(packageJson.version),
  },
});
