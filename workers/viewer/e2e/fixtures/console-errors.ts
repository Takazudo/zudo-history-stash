import { test as base } from "@playwright/test";

export interface AllowedConsoleError {
  pattern: RegExp;
  why: string;
}

interface ConsoleErrorOptions {
  allowedConsoleErrors: AllowedConsoleError[];
}

export const test = base.extend<ConsoleErrorOptions>({
  // Keep this empty by default. Every test-specific exception must include a narrow pattern and why.
  allowedConsoleErrors: [[], { option: true }],
  page: async ({ page, allowedConsoleErrors }, use) => {
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
