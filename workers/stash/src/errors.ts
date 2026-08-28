import { StashError, type ErrorResponse } from "@takazudo/zudo-history-stash-core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorHandler } from "hono";
import type { AppEnv } from "./context.js";

export const onError: ErrorHandler<AppEnv> = (error, c) => {
  const stashError =
    error instanceof StashError ? error : new StashError("internal", "An internal error occurred.");
  const payload: ErrorResponse = {
    error: {
      code: stashError.code,
      message: stashError.message,
      ...(stashError.successorId === undefined ? {} : { successorId: stashError.successorId }),
    },
  };

  if (stashError.status === 409 && stashError.current !== undefined) {
    payload.current = stashError.current;
  }
  return c.json(payload, stashError.status as ContentfulStatusCode);
};
