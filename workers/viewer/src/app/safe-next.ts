export function isSafeNext(next: string | null | undefined): next is string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return false;
  if (
    next.includes("\\") ||
    [...next].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    return false;

  try {
    const origin = "https://viewer.invalid";
    const parsed = new URL(next, origin);
    return parsed.origin === origin && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}

export function defaultPathForPrincipal(
  me: { principal: "admin" } | { principal: "stash"; stash: string },
): string {
  return me.principal === "admin" ? "/" : `/s/${me.stash}`;
}
