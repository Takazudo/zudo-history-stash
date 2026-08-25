import type {
  ApiError,
  ErrorResponse,
  MeResponse,
  Result,
} from "@takazudo/zudo-history-stash-core";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { clearToken as clearStoredToken, getToken, setToken as storeToken } from "./token-store.js";

export interface ViewerStashClient {
  me(options?: { signal?: AbortSignal }): Promise<Result<MeResponse>>;
}

interface StashClientContextValue {
  token: string | null;
  client: ViewerStashClient | null;
  authenticate(token: string): Promise<Result<MeResponse>>;
  logOut(): void;
}

const StashClientContext = createContext<StashClientContextValue | null>(null);

function toApiError(response: Response, body: ErrorResponse | null): ApiError {
  return {
    status: response.status,
    code: body?.error.code ?? "internal",
    message: body?.error.message ?? `Request failed with status ${response.status}`,
  };
}

async function parseError(response: Response): Promise<ErrorResponse | null> {
  try {
    return (await response.json()) as ErrorResponse;
  } catch {
    return null;
  }
}

export function createViewerStashClient(
  token: string,
  onUnauthorized: () => void,
  fetchImplementation: typeof fetch = fetch,
): ViewerStashClient {
  return {
    async me(options) {
      let response: Response;
      try {
        response = await fetchImplementation("/api/v1/me", {
          headers: { authorization: `Bearer ${token}` },
          signal: options?.signal,
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            status: 0,
            code: "internal",
            message: error instanceof Error ? error.message : "The request failed",
          },
        };
      }

      if (response.ok) {
        try {
          return { ok: true, value: (await response.json()) as MeResponse };
        } catch {
          return {
            ok: false,
            error: {
              status: response.status,
              code: "internal",
              message: "The API response was not valid JSON",
            },
          };
        }
      }

      if (response.status === 401) onUnauthorized();
      return { ok: false, error: toApiError(response, await parseError(response)) };
    },
  };
}

export function StashClientProvider({ children }: { children: ReactNode }) {
  const [token, setCurrentToken] = useState(getToken);

  const logOut = useCallback(() => {
    clearStoredToken();
    setCurrentToken(null);
  }, []);

  const client = useMemo(
    () => (token ? createViewerStashClient(token, logOut) : null),
    [logOut, token],
  );

  const authenticate = useCallback(
    async (candidate: string) => {
      const candidateClient = createViewerStashClient(candidate, logOut);
      const result = await candidateClient.me();
      if (result.ok) {
        storeToken(candidate);
        setCurrentToken(candidate);
      }
      return result;
    },
    [logOut],
  );

  const value = useMemo(
    () => ({ token, client, authenticate, logOut }),
    [authenticate, client, logOut, token],
  );

  return <StashClientContext.Provider value={value}>{children}</StashClientContext.Provider>;
}

export function useStashClient(): StashClientContextValue {
  const value = useContext(StashClientContext);
  if (!value) throw new Error("useStashClient must be used inside StashClientProvider");
  return value;
}
