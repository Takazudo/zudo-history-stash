import {
  StashHttpError,
  createStashClient,
  type ClientResult,
  type MeResponse,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { clearToken as clearStoredToken, getToken, setToken as storeToken } from "./token-store.js";

export interface ViewerStashClient extends StashClient {
  me(options?: { signal?: AbortSignal }): Promise<ClientResult<MeResponse>>;
  withSignal(signal: AbortSignal): StashClient;
}

export type ViewerStashClientFactory = (
  token: string,
  onUnauthorized: () => void,
) => ViewerStashClient;

interface StashClientContextValue {
  token: string | null;
  client: ViewerStashClient | null;
  authenticate(token: string): Promise<ClientResult<MeResponse>>;
  logOut(): void;
}

const StashClientContext = createContext<StashClientContextValue | null>(null);

function messageFromHttpError(error: StashHttpError): string {
  if (error.body && typeof error.body === "object" && "error" in error.body) {
    const detail = error.body.error;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = detail.message;
      if (typeof message === "string") return message;
    }
  }
  return error.cause instanceof Error ? error.cause.message : error.message;
}

async function readMe(client: StashClient): Promise<ClientResult<MeResponse>> {
  try {
    return await client.me();
  } catch (error) {
    if (!(error instanceof StashHttpError)) throw error;
    return {
      ok: false,
      error: {
        status: error.status,
        code: error.code ?? "internal",
        message: messageFromHttpError(error),
      },
    };
  }
}

export function createViewerStashClient(
  token: string,
  onUnauthorized: () => void,
  fetchImplementation: StashFetch = globalThis.fetch.bind(globalThis),
): ViewerStashClient {
  const createClient = (signal?: AbortSignal): StashClient =>
    createStashClient({
      baseUrl: "/api",
      token,
      fetch: async (input, init) => {
        const response = await fetchImplementation(
          input,
          signal && !init?.signal ? { ...init, signal } : init,
        );
        if (response.status === 401) onUnauthorized();
        return response;
      },
    });

  const client = createClient();
  return {
    ...client,
    me: (options) => readMe(options?.signal ? createClient(options.signal) : client),
    withSignal: (signal) => createClient(signal),
  };
}

export function StashClientProvider({
  children,
  clientFactory = createViewerStashClient,
}: {
  children: ReactNode;
  clientFactory?: ViewerStashClientFactory;
}) {
  const [token, setCurrentToken] = useState(getToken);

  const logOut = useCallback(() => {
    clearStoredToken();
    setCurrentToken(null);
  }, []);

  const client = useMemo(
    () => (token ? clientFactory(token, logOut) : null),
    [clientFactory, logOut, token],
  );

  const authenticate = useCallback(
    async (candidate: string) => {
      const candidateClient = clientFactory(candidate, logOut);
      const result = await candidateClient.me();
      if (result.ok) {
        storeToken(candidate);
        setCurrentToken(candidate);
      }
      return result;
    },
    [clientFactory, logOut],
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
