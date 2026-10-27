export * from "@t3tools/shared/advertisedEndpoint";

/**
 * An environment can be served under a base path (`https://host/s/space/`), so endpoint paths
 * are joined onto the base URL's path instead of replacing it. A root base URL behaves as before.
 */
const joinBasePath = (basePath: string, pathname: string): string => {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return `${base}${pathname.replace(/^\/+/, "")}`;
};

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = joinBasePath(url.pathname, pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
};

/**
 * The RPC socket of an environment. A base URL ending in `/` (the root or a base path) gets the
 * standard `ws` endpoint; any other path is taken as the socket URL itself.
 */
export const environmentSocketUrl = (wsBaseUrl: string): URL => {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname.endsWith("/")) {
    url.pathname = joinBasePath(url.pathname, "ws");
  }
  return url;
};

/**
 * Resolves a URL the server returned (assets, uploads, webhooks). Root-relative paths belong to
 * the environment, so they are placed under its base path unless the server already did that.
 */
export const resolveEnvironmentRelativeUrl = (httpBaseUrl: string, relativeUrl: string): string => {
  const base = new URL(httpBaseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (basePath === "/" || !relativeUrl.startsWith("/") || relativeUrl.startsWith("//")) {
    return new URL(relativeUrl, base).toString();
  }
  if (relativeUrl.startsWith(basePath)) {
    return new URL(relativeUrl, `${base.protocol}//${base.host}`).toString();
  }
  return new URL(joinBasePath(basePath, relativeUrl), `${base.protocol}//${base.host}`).toString();
};
