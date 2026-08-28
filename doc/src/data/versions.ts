import clientPackage from "../../../packages/client/package.json";
import corePackage from "../../../packages/core/package.json";
import openApi from "../../../docs/openapi.json";
import rootPackage from "../../../package.json";
import uiPackage from "../../../packages/ui/package.json";
import docPackage from "../../package.json";

export const projectVersions = {
  core: corePackage.version,
  client: clientPackage.version,
  ui: uiPackage.version,
  api: openApi.info.version,
  node: rootPackage.engines.node,
  pnpm: rootPackage.packageManager,
  wrangler: docPackage.devDependencies.wrangler,
} as const;
