declare module "*?raw" {
  const source: string;
  export default source;
}

interface ImportMeta {
  glob(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, unknown>;
}
