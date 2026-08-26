import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY, clearToken, getToken, setToken } from "./token-store.js";

beforeEach(() => {
  sessionStorage.clear();
});

describe("token store", () => {
  it("reports successful credential persistence and removal", () => {
    expect(getToken()).toBeNull();
    expect(setToken("zhs_admin")).toBe(true);
    expect(getToken()).toBe("zhs_admin");
    expect(clearToken()).toBe(true);
    expect(getToken()).toBeNull();
  });

  it("treats a credential read failure as unauthenticated", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(getToken()).toBeNull();
  });

  it("reports credential write and removal failures without throwing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(setToken("zhs_admin")).toBe(false);
    setItem.mockRestore();

    sessionStorage.setItem(TOKEN_STORAGE_KEY, "zhs_admin");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(clearToken()).toBe(false);
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("zhs_admin");
  });
});
