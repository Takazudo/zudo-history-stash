import { test as base } from "@playwright/test";

interface AllowedConsoleError {
  pattern: RegExp;
  why: string;
}

// Keep this list empty by default. Every future exception must include a narrow pattern and why.
const allowedConsoleErrors: AllowedConsoleError[] = [];

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (!allowedConsoleErrors.some(({ pattern }) => pattern.test(text))) errors.push(text);
    });

    await use(page);

    if (errors.length > 0) {
      throw new Error(`Unexpected browser console errors:\n${errors.join("\n")}`);
    }
  },
});

export { expect } from "@playwright/test";
