export const TOKEN_STORAGE_KEY = "zhs.token";

function withSessionStorage<T>(operation: (storage: Storage) => T, fallback: T): T {
  try {
    return operation(window.sessionStorage);
  } catch {
    return fallback;
  }
}

export function getToken(): string | null {
  return withSessionStorage((storage) => storage.getItem(TOKEN_STORAGE_KEY), null);
}

export function setToken(token: string): boolean {
  return withSessionStorage((storage) => {
    storage.setItem(TOKEN_STORAGE_KEY, token);
    return true;
  }, false);
}

export function clearToken(): boolean {
  return withSessionStorage((storage) => {
    storage.removeItem(TOKEN_STORAGE_KEY);
    return true;
  }, false);
}
