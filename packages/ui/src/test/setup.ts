import { cleanup, configure } from "@testing-library/react";
import { Buffer } from "node:buffer";
import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";

// The workspace runs UI and workerd suites concurrently. Leave enough room for
// passive effects and async queries to settle under CI load while Vitest's
// five-second test timeout still bounds genuine failures.
configure({ asyncUtilTimeout: 3_000 });

// The minimum supported Node release rejects jsdom-realm BufferSource values
// in Web Crypto. Bridge digest inputs into Node's realm so browser upload code
// exercises the standard API under every supported test runtime.
const nativeSubtle = globalThis.crypto?.subtle ?? webcrypto.subtle;
const subtle = new Proxy(nativeSubtle, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "digest" && typeof value === "function") {
      return (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        return Reflect.apply(value, target, [algorithm, Buffer.from(bytes)]);
      };
    }
    return typeof value === "function" ? value.bind(target) : value;
  },
});
Object.defineProperty(globalThis.crypto, "subtle", {
  configurable: true,
  value: subtle,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
  }

  if (typeof HTMLDialogElement.prototype.close !== "function") {
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    });
  }
}
