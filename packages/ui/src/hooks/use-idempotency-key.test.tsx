import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useIdempotencyKey } from "./use-idempotency-key.js";

function KeyHarness() {
  const getKey = useIdempotencyKey();
  const [keys, setKeys] = useState<string[]>([]);
  return (
    <>
      <button type="button" onClick={() => setKeys((current) => [...current, getKey()])}>
        Mint key
      </button>
      <output>{keys.join("|")}</output>
    </>
  );
}

describe("useIdempotencyKey", () => {
  it("mints lazily once and stays stable under StrictMode renders", async () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000019");
    render(
      <StrictMode>
        <KeyHarness />
      </StrictMode>,
    );

    expect(randomUUID).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Mint key" }));
    await userEvent.click(screen.getByRole("button", { name: "Mint key" }));

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(
      "00000000-0000-4000-8000-000000000019|00000000-0000-4000-8000-000000000019",
    );
  });
});
