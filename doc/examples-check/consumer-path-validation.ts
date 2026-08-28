import { validatePath, validateStashName } from "@takazudo/zudo-history-stash";

export function validateFileTarget(stash: string, path: string) {
  const stashResult = validateStashName(stash);
  if (!stashResult.ok) {
    return { ok: false as const, field: "stash" as const, error: stashResult };
  }

  const pathResult = validatePath(path);
  if (!pathResult.ok) {
    return { ok: false as const, field: "path" as const, error: pathResult };
  }

  return { ok: true as const, stash, path };
}
