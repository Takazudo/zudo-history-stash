// @ts-check

/**
 * @typedef {import("@takazudo/zudo-doc/integrations/changelog").ChangelogConfig & {
 *   slug: "core" | "client" | "ui";
 * }} ProjectChangelogConfig
 */

/** @type {readonly ProjectChangelogConfig[]} */
export const CHANGELOGS = Object.freeze([
  Object.freeze({
    slug: "core",
    sourceDir: "src/content/docs/changelog/core",
    outputFile: "../packages/core/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash-core",
  }),
  Object.freeze({
    slug: "client",
    sourceDir: "src/content/docs/changelog/client",
    outputFile: "../packages/client/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash",
  }),
  Object.freeze({
    slug: "ui",
    sourceDir: "src/content/docs/changelog/ui",
    outputFile: "../packages/ui/CHANGELOG.md",
    packageName: "@takazudo/zudo-history-stash-ui",
  }),
]);
