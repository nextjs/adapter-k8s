import { REQUEST_HEAD_TIMEOUT_MS } from "./dispatch.js";
import {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_SECRET_HEADER,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
} from "../routing-common.js";

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function clean(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  const nominated = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase());
  for (const name of [...hopHeaders, ...nominated]) delete result[name];
  return result;
}

/** One streaming attempt. Never replay a POST, even if the origin resets before headers. */
export function proxyRetainedBuild(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  timeoutMs = REQUEST_HEAD_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const headers = clean(req.headers);
    for (const name of [
      ...INTERNAL_DISPATCH_HEADERS,
      ...UNTRUSTED_NEXT_REQUEST_HEADERS,
      INTERNAL_DISPATCH_PROOF_HEADER,
      INTERNAL_SECRET_HEADER,
      "x-adapter-middle-cache",
      "x-adapter-asset",
    ])
      delete headers[name];
    const upstream = request(
      origin,
      { path: req.url, method: req.method, headers, agent: false },
      (response) => {
        clearTimeout(timer);
        // An old response must not populate the active build's CDN key. The retained
        // pool still evaluates its own middleware and may cache asset bytes locally.
        res.writeHead(response.statusCode ?? 502, {
          ...clean(response.headers),
          "cache-control": "no-store",
        });
        response.on("error", (error) => res.destroy(error));
        response.pipe(res);
      },
    );
    const timer = setTimeout(
      () => upstream.destroy(new Error("Retained build timed out")),
      timeoutMs,
    );
    upstream.on("error", () => {
      clearTimeout(timer);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "cache-control": "no-store" });
        res.end("Retained build unavailable");
      }
      resolve();
    });
    res.on("close", () => {
      clearTimeout(timer);
      upstream.destroy();
      resolve();
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}
