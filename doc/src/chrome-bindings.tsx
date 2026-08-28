import { defineChromeBindings } from "@takazudo/zudo-doc/chrome-bindings";
import type { ComponentChildren } from "preact";
import { OPENAPI_HREF } from "./data/site-paths.ts";
import { projectVersions } from "./data/versions.ts";

type VersionName = keyof typeof projectVersions;

function VersionValue({ name }: { name: VersionName }) {
  return <code>{projectVersions[name]}</code>;
}

function OpenApiLink({ children }: { children: ComponentChildren }) {
  return <a href={OPENAPI_HREF}>{children}</a>;
}

export const chromeBindings = defineChromeBindings({
  mdxExtras: { OpenApiLink, VersionValue },
});
