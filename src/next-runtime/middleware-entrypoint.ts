type MiddlewareCallable = (...args: unknown[]) => unknown;

export type NodeMiddlewareEntrypoint =
  | { kind: "generated"; invoke: MiddlewareCallable }
  | { kind: "web-adapter"; invoke: MiddlewareCallable; handler: unknown }
  | { kind: "legacy"; invoke: MiddlewareCallable }
  | { kind: "direct"; invoke: MiddlewareCallable }
  | { kind: "unsupported"; error: UnsupportedMiddlewareEntrypointError };

export type NodeMiddlewareInvocationResult =
  | {
      kind: "response";
      entrypoint: Exclude<NodeMiddlewareEntrypoint["kind"], "unsupported">;
      response: Response;
    }
  | { kind: "unsupported"; error: UnsupportedMiddlewareEntrypointError }
  | { kind: "invalid-result"; error: InvalidMiddlewareResultError };

export interface NodeMiddlewareInvocationOptions {
  url: URL;
  headers: Headers;
  method: string;
  requestBody: ReadableStream<Uint8Array>;
  nextConfig: Record<string, unknown>;
  /** Absolute Next build directory for generated middleware instrumentation registration. */
  distDir: string;
  signal?: AbortSignal | null;
  getCloneableBody?: ((readable: unknown) => unknown) | null;
  logBackgroundError(error: unknown): void;
}

export class UnsupportedMiddlewareEntrypointError extends Error {
  constructor() {
    super(
      "Loaded module has no supported Next.js middleware entrypoint for the 16.3 release line.",
    );
    this.name = "UnsupportedMiddlewareEntrypointError";
  }
}

export class InvalidMiddlewareResultError extends Error {
  constructor(entrypoint: Exclude<NodeMiddlewareEntrypoint["kind"], "unsupported">) {
    super(`Next.js ${entrypoint} middleware entrypoint returned no Response.`);
    this.name = "InvalidMiddlewareResultError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? (value as Record<string, unknown>)
    : null;
}

function callable(value: unknown): MiddlewareCallable | null {
  return typeof value === "function" ? (value as MiddlewareCallable) : null;
}

/**
 * Discriminate the Node middleware module once, before invocation.
 *
 * ORDER IS LOAD-BEARING. Next 16.3's generated `handler(Request, ctx)` must win over the
 * backwards-compatible wrappers shipped beside it. Invoking one of those wrappers with the wrong
 * shape can silently produce `next()` and bypass the user's proxy. The installed 16.3 template
 * exports `handler` plus a default internal adapter; dynamic import of its CJS build can nest both
 * under `default`, so both placements are recognized. The remaining shapes are compatibility
 * paths already measured by the real-build parity fixtures, in the historical order shared by
 * both runtime tiers.
 *
 * N40 measurement, retained here because it explains the order: a real CJS artifact shaped
 * `{ default: { default: adapterWrapper, handler } }` made the callable-default path unreachable.
 * When the edge instead invoked `default.default` without `nextConfig` on a build with
 * `basePath: "/docs"` plus i18n, userland saw pathname `/docs/about` and locale `""`; the
 * generated handler and `next start` saw `/about` and `en`. The legacy wrapper produces the same
 * x-middleware control headers when it receives the same config, so header stripping was never a
 * valid reason for this ordering. Every compatibility path below receives the same manifest
 * config; generated still wins because its build wrapper owns normalization.
 */
export function detectNodeMiddlewareEntrypoint(module: unknown): NodeMiddlewareEntrypoint {
  const exports = record(module);
  if (!exports) return { kind: "unsupported", error: new UnsupportedMiddlewareEntrypointError() };

  const nestedDefault = record(exports.default);
  const generated = callable(exports.handler) ?? callable(nestedDefault?.handler);
  if (generated) return { kind: "generated", invoke: generated };

  const adapter = callable(exports.default);
  if (adapter) {
    const handler = callable(exports.proxy) ?? callable(exports.middleware) ?? module;
    return { kind: "web-adapter", invoke: adapter, handler };
  }

  const legacy = callable(nestedDefault?.default);
  if (legacy) return { kind: "legacy", invoke: legacy };

  const direct = callable(exports.proxy) ?? callable(exports.middleware) ?? callable(module);
  if (direct) return { kind: "direct", invoke: direct };

  return { kind: "unsupported", error: new UnsupportedMiddlewareEntrypointError() };
}

export function hasCallableNodeMiddlewareEntrypoint(module: unknown): boolean {
  return detectNodeMiddlewareEntrypoint(module).kind !== "unsupported";
}

function responseFrom(value: unknown): Response | null {
  if (value instanceof Response) return value;
  const result = record(value);
  return result?.response instanceof Response ? result.response : null;
}

function waitUntilFrom(value: unknown): Promise<unknown> | null {
  const waitUntil = record(value)?.waitUntil;
  return waitUntil && typeof (waitUntil as { then?: unknown }).then === "function"
    ? (waitUntil as Promise<unknown>)
    : null;
}

function requestInit(options: NodeMiddlewareInvocationOptions): RequestInit & { duplex?: "half" } {
  const init: RequestInit & { duplex?: "half" } = {
    method: options.method,
    headers: new Headers([...options.headers.entries()].filter(([key]) => !key.startsWith(":"))),
    duplex: "half",
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.method !== "GET" && options.method !== "HEAD") init.body = options.requestBody;
  return init;
}

/** Invoke exactly one discriminated entrypoint and normalize its response contract. */
export async function invokeNodeMiddleware(
  module: unknown,
  options: NodeMiddlewareInvocationOptions,
): Promise<NodeMiddlewareInvocationResult> {
  const entrypoint = detectNodeMiddlewareEntrypoint(module);
  if (entrypoint.kind === "unsupported") return entrypoint;

  const observedWaitUntil = new Set<PromiseLike<unknown>>();
  const observeWaitUntil = (waitable: PromiseLike<unknown>) => {
    if (observedWaitUntil.has(waitable)) return;
    observedWaitUntil.add(waitable);
    void Promise.resolve(waitable).catch(options.logBackgroundError);
  };
  const waitUntil = (waitable: Promise<unknown>) => {
    observeWaitUntil(waitable);
  };

  let result: unknown;
  switch (entrypoint.kind) {
    case "generated":
      result = await entrypoint.invoke(new Request(options.url, requestInit(options)), {
        waitUntil,
        requestMeta: { relativeProjectDir: ".", distDir: options.distDir },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      break;
    case "web-adapter": {
      let body: unknown;
      if (options.method !== "GET" && options.method !== "HEAD") {
        if (options.getCloneableBody) {
          const { Readable } = await import("node:stream");
          body = options.getCloneableBody(Readable.fromWeb(options.requestBody));
        } else {
          body = options.requestBody;
        }
      }
      result = await entrypoint.invoke({
        handler: entrypoint.handler,
        request: {
          url: options.url.toString(),
          method: options.method,
          headers: Object.fromEntries(
            [...options.headers.entries()].filter(([key]) => !key.startsWith(":")),
          ),
          body,
          signal: options.signal ?? new AbortController().signal,
          nextConfig: options.nextConfig,
          waitUntil,
        },
        page: "middleware",
      });
      break;
    }
    case "legacy":
      result = await entrypoint.invoke({
        request: {
          url: options.url.toString(),
          method: options.method,
          headers: Object.fromEntries(
            [...options.headers.entries()].filter(([key]) => !key.startsWith(":")),
          ),
          body:
            options.method !== "GET" && options.method !== "HEAD" ? options.requestBody : undefined,
          signal: options.signal ?? new AbortController().signal,
          nextConfig: options.nextConfig,
          destination: "document",
          credentials: "same-origin",
          bodyUsed: false,
          mode: "navigate",
          redirect: "follow",
        },
      });
      break;
    case "direct":
      result = await entrypoint.invoke(new Request(options.url, requestInit(options)), {
        waitUntil,
      });
      break;
  }

  const returnedWaitUntil = waitUntilFrom(result);
  if (returnedWaitUntil) observeWaitUntil(returnedWaitUntil);

  // A direct raw userland proxy may return undefined to mean `NextResponse.next()`. The generated
  // and adapter wrappers normalize that into an x-middleware-next Response themselves; this
  // compatibility path has no wrapper, so do the same explicitly instead of confusing a valid
  // no-op verdict with an unknown result shape.
  const response =
    entrypoint.kind === "direct" && result === undefined
      ? new Response(null, { headers: { "x-middleware-next": "1" } })
      : responseFrom(result);
  return response
    ? { kind: "response", entrypoint: entrypoint.kind, response }
    : { kind: "invalid-result", error: new InvalidMiddlewareResultError(entrypoint.kind) };
}
