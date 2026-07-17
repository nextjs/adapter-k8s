// Apply a middleware request-header mutation set to a Node request, authoritatively.
//
// `middlewareRequestHeaders` (from the resolver, produced by @next/routing running middleware) is
// the COMPLETE intended request-header set — a header the middleware removed is simply absent, so
// we REPLACE req.headers rather than merge (merging would resurrect a header middleware deleted,
// e.g. a spoofed identity header). Shared by the HTTP dispatcher and the WebSocket upgrade path so
// both hand the route the exact headers middleware intended.
import type { IncomingMessage } from "node:http";

export function applyMiddlewareRequestHeaders(
  req: Pick<IncomingMessage, "headers">,
  middlewareRequestHeaders: Headers,
): void {
  const originalHost = req.headers.host;
  const nextHeaders: IncomingMessage["headers"] = {};
  for (const [key, value] of middlewareRequestHeaders.entries()) {
    if (key === "x-middleware-set-cookie") {
      // Parse Set-Cookie values and merge into the cookie header so the handler can read
      // middleware-set cookies within the same request.
      const parts: string[] = [];
      for (const sc of value.split(/,(?=[^;]*=)/)) {
        const nameVal = sc.trim().split(";")[0];
        if (nameVal) parts.push(nameVal);
      }
      if (parts.length > 0) {
        const existing = middlewareRequestHeaders.get("cookie") ?? "";
        nextHeaders.cookie = [existing, ...parts].filter(Boolean).join("; ");
      }
      continue;
    }
    // Skip internal x-middleware-* control headers.
    if (key.startsWith("x-middleware-")) continue;
    nextHeaders[key] = value;
  }
  if (!nextHeaders.host && originalHost) nextHeaders.host = originalHost;
  req.headers = nextHeaders;
}
