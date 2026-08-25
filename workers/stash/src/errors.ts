import { StashError } from "@takazudo/zudo-history-stash-core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorHandler } from "hono";
import type { AppEnv } from "./context.js";

export const onError: ErrorHandler<AppEnv> = (error, c) => {
  const stashError =
    error instanceof StashError ? error : new StashError("internal", "An internal error occurred.");
  const payload: {
    error: { code: string; message: string };
    current?: StashError["current"];
  } = { error: { code: stashError.code, message: stashError.message } };

  if (stashError.status === 409 && stashError.current !== undefined) {
    payload.current = stashError.current;
  }
  return c.json(payload, stashError.status as ContentfulStatusCode);
};
