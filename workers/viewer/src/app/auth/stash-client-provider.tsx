import {
  StashHttpError,
  createStashClient,
  type ClientResult,
  type MeResponse,
  type StashClient,
  type StashFetch,
} from "@takazudo/zudo-history-stash";
import { clearWorkbenchDraftsForCredentialChange } from "@takazudo/zudo-history-stash-ui";
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
  credentialBoundaryWarning: string | null;
  authenticate(token: string): Promise<ClientResult<MeResponse>>;
  logOut(): void;
}

const StashClientContext = createContext<StashClientContextValue | null>(null);
const PERSISTED_TOKEN_WARNING =
  "Signed out in this page, but browser storage could not be fully cleared. The saved token may become active again after reload. Close this tab and clear its site data before continuing.";
const PERSISTED_DRAFT_WARNING =
  "Signed out, but workbench drafts could not be cleared. Close this tab and clear its site data before signing in as another principal.";

function warningAfterLogout(draftsCleared: boolean, tokenCleared: boolean): string | null {
  if (!tokenCleared) return PERSISTED_TOKEN_WARNING;
  if (!draftsCleared) return PERSISTED_DRAFT_WARNING;
  return null;
}

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
  const [credentialBoundaryWarning, setCredentialBoundaryWarning] = useState<string | null>(null);

  const logOut = useCallback(() => {
    let draftsCleared = false;
    let tokenCleared = false;
    try {
      try {
        draftsCleared = clearWorkbenchDraftsForCredentialChange();
      } catch {
        draftsCleared = false;
      }
      try {
        tokenCleared = clearStoredToken();
      } catch {
        tokenCleared = false;
      }
    } finally {
      setCurrentToken(null);
      setCredentialBoundaryWarning(warningAfterLogout(draftsCleared, tokenCleared));
    }
  }, []);

  const client = useMemo(
    () => (token ? clientFactory(token, logOut) : null),
    [clientFactory, logOut, token],
  );

  const authenticate = useCallback(
    async (candidate: string): Promise<ClientResult<MeResponse>> => {
      const candidateClient = clientFactory(candidate, logOut);
      const result = await candidateClient.me();
      if (result.ok) {
        if (!clearWorkbenchDraftsForCredentialChange()) {
          return {
            ok: false,
            error: {
              status: 500,
              code: "internal",
              message: "Workbench drafts could not be cleared. Try signing in again.",
            },
          };
        }
        if (!storeToken(candidate)) {
          return {
            ok: false,
            error: {
              status: 500,
              code: "internal",
              message:
                "The credential could not be stored in this tab. Allow session storage and try again.",
            },
          };
        }
        setCredentialBoundaryWarning(null);
        setCurrentToken(candidate);
      }
      return result;
    },
    [clientFactory, logOut],
  );

  const value = useMemo(
    () => ({ token, client, credentialBoundaryWarning, authenticate, logOut }),
    [authenticate, client, credentialBoundaryWarning, logOut, token],
  );

  return <StashClientContext.Provider value={value}>{children}</StashClientContext.Provider>;
}

export function useStashClient(): StashClientContextValue {
  const value = useContext(StashClientContext);
  if (!value) throw new Error("useStashClient must be used inside StashClientProvider");
  return value;
}
