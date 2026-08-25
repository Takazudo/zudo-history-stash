export const TOKEN_STORAGE_KEY = "zhs.token";

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return getSessionStorage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
}

export function setToken(token: string): void {
  getSessionStorage()?.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  getSessionStorage()?.removeItem(TOKEN_STORAGE_KEY);
}
