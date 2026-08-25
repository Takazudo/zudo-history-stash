import { useCallback, useRef } from "react";

/** Return a lazy getter that mints one mutation key for the mounted dialog. */
export function useIdempotencyKey(): () => string {
  const keyRef = useRef<string | null>(null);
  return useCallback(() => {
    if (keyRef.current === null) keyRef.current = globalThis.crypto.randomUUID();
    return keyRef.current;
  }, []);
}
