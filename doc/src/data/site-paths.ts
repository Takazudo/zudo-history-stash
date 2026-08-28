export const DOC_BASE_PATH = "/";

export function withDocBase(path: `/${string}`, basePath = DOC_BASE_PATH): string {
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${normalizedBase}${path}`;
}

export const OPENAPI_HREF = withDocBase("/openapi.json");
