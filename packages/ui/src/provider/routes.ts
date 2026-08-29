import type { StashHrefFor, StashUiRoute } from "./types.js";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function appendQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) query.set(name, String(value));
  }
  const serialized = query.toString();
  return serialized.length === 0 ? path : `${path}?${serialized}`;
}

export function defaultStashHref(route: StashUiRoute): string {
  if (route.kind === "home") return "/";

  const stashBase = `/s/${encodeURIComponent(route.stash)}`;
  if (route.kind === "stash") return stashBase;
  if (route.kind === "new-file") return `${stashBase}/new`;
  if (route.kind === "tokens") return `${stashBase}/tokens`;
  if (route.kind === "commits") return `${stashBase}/commits`;
  if (route.kind === "commit") return `${stashBase}/commits/${encodeURIComponent(route.id)}`;
  if (route.kind === "change-sets") return `${stashBase}/change-sets`;
  if (route.kind === "change-set") {
    return `${stashBase}/change-sets/${encodeURIComponent(route.id)}`;
  }

  const encodedPath = encodePath(route.path);
  if (route.kind === "file") {
    return appendQuery(`${stashBase}/f/${encodedPath}`, { version: route.version });
  }
  if (route.kind === "edit") {
    return appendQuery(`${stashBase}/edit/${encodedPath}`, { from: route.from });
  }
  return appendQuery(`${stashBase}/diff/${encodedPath}`, {
    from: route.from,
    to: route.to,
    context: route.context,
  });
}

export const defaultStashHrefFor: StashHrefFor = defaultStashHref;
