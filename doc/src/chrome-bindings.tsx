import { defineChromeBindings } from "@takazudo/zudo-doc/chrome-bindings";
import { projectVersions } from "./data/versions.ts";

type VersionName = keyof typeof projectVersions;

function VersionValue({ name }: { name: VersionName }) {
  return <code>{projectVersions[name]}</code>;
}

export const chromeBindings = defineChromeBindings({
  mdxExtras: { VersionValue },
});
