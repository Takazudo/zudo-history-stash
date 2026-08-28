import { defineConfig } from "zfb/config";
import { zudoDoc } from "@takazudo/zudo-doc/config";
import { DOC_BASE_PATH } from "./src/data/site-paths.ts";

const config = zudoDoc({
  base: DOC_BASE_PATH,
  themePack: "drift",
  siteName: "zudo-history-stash",
  siteUrl: "https://zudo-history-stash.zudolab.dev",
  githubUrl: "https://github.com/Takazudo/zudo-history-stash",
  chromeBindingsModule: "src/chrome-bindings.tsx",
  locales: {
    ja: {
      label: "JA",
      dir: "src/content/docs-ja",
    },
  },
  metaTags: {
    description: true,
    keywords: "Cloudflare, file history, git like",
    ogImage: "/img/ogp.png",
    ogSiteName: true,
    twitterCard: false,
  },
  llmsTxt: true,
  cjkFriendly: true,
  sidebarResizer: true,
  sidebarToggle: true,
  tocToggle: true,
  imageEnlarge: true,
  dynamicPageTransition: true,
  docHistory: true,
  versions: [],
  claudeResources: {
    claudeDir: "../.claude",
    projectRoot: ".",
    scanRoot: "..",
  },
  defaultLocaleOnlyPrefixes: [
    "/docs/claude-md/",
    "/docs/claude-skills/",
    "/docs/claude-agents/",
    "/docs/claude-commands/",
  ],
  footer: {
    links: [],
    copyright: "Copyright © 2026 Takeshi Takatsudo. Built with zudo-doc.",
  },
  headerNav: [
    {
      label: "Getting Started",
      path: "/docs/getting-started",
      categoryMatch: "getting-started",
    },
    {
      label: "Guides",
      path: "/docs/guides",
      categoryMatch: "guides",
    },
    {
      label: "Reference",
      path: "/docs/reference",
      categoryMatch: "reference",
    },
    {
      label: "Changelog",
      path: "/docs/changelog",
      categoryMatch: "changelog",
    },
    {
      label: "Versions",
      path: "/docs/reference/versions",
      categoryMatch: "reference",
    },
    {
      label: "Claude",
      path: "/docs/claude",
      categoryMatch: "claude",
      versioned: false,
    },
  ],
  headerRightItems: [
    {
      type: "component",
      component: "github-link",
    },
    {
      type: "component",
      component: "theme-toggle",
    },
    {
      type: "component",
      component: "search",
    },
    {
      type: "component",
      component: "language-switcher",
    },
  ],
  adapter: "@takazudo/zfb-adapter-cloudflare",
});

config.plugins = [
  ...(config.plugins ?? []),
  {
    name: "./plugins/normalize-generated-skill-links.mjs",
    options: {
      generatedSkillsDir: "src/content/docs/claude-skills",
      sourceSkillsDir: "../.claude/skills",
      repositoryRoot: "..",
      repositoryUrl: "https://github.com/Takazudo/zudo-history-stash",
      branch: "main",
    },
  },
];

export default defineConfig(config);
