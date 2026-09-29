function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  );
}

/**
 * A loopback endpoint is relative to each browser. When the app itself is
 * opened remotely, route the World socket through the same-origin proxy.
 */
export function resolveWorldSocketUrl(
  worldUrl: string | undefined,
  path: string,
  pageHref: string,
) {
  const page = new URL(pageHref);
  const scheme = page.protocol === "https:" ? "wss:" : "ws:";
  const socketOrigin = `${scheme}//${page.host}`;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!worldUrl) return `${socketOrigin}${normalizedPath}`;

  let endpoint: URL;
  try {
    endpoint = new URL(worldUrl, page);
  } catch {
    return worldUrl;
  }

  if (
    (endpoint.protocol === "ws:" || endpoint.protocol === "wss:") &&
    isLoopback(endpoint.hostname) &&
    !isLoopback(page.hostname)
  ) {
    return `${socketOrigin}${endpoint.pathname}${endpoint.search}`;
  }

  return worldUrl;
}
