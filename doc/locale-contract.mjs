export const DEFAULT_LOCALE = "en";
export const LOCALIZED_LOCALE = "ja";

export const DEFAULT_LOCALE_ONLY_PREFIXES = Object.freeze([
  "/docs/claude-md/",
  "/docs/claude-skills/",
  "/docs/claude-agents/",
  "/docs/claude-commands/",
]);

// zudo-doc generates this shared overview in the default source tree and serves
// the same route in both locales. It is not a fifth default-locale-only prefix.
export const SHARED_GENERATED_SOURCE_PATHS = Object.freeze(["claude/index.mdx"]);
